// Execute the real Lua scripts with ioredis-mock; no external Redis is used.
// Cross-process atomicity and Redis server expiry still need integration tests.
const RedisMock = require('ioredis-mock');
const { createWorkspaceBudget } = require('../../../src/agent/services/budget.service');
const { agentBudgetKey, TTL } = require('../../../src/config/redis-keys');
const { normalizeProviderError } = require('../../../src/agent/providers/provider-errors');
const logger = require('../../../src/utils/logger');

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const context = (workspaceId = WORKSPACE_ID) => ({
  userId: '11111111-1111-4111-8111-111111111111',
  member: { id: '22222222-2222-4222-8222-222222222222', workspaceId, role: 'member', isActive: true },
  workspace: { id: workspaceId },
});
const usage = (totalTokens) => ({ promptTokens: totalTokens, completionTokens: 0, totalTokens });
const keyOf = (ticket) => agentBudgetKey(ticket.workspaceId, ticket.period, ticket.windowStartMs);

describe('shared workspace token budget', () => {
  let redis;
  const budget = (options = {}) => createWorkspaceBudget({
    context: context(), limit: 1000, period: 'day', redisFactory: () => redis, ...options,
  });

  beforeEach(async () => {
    redis = new RedisMock();
    // ioredis-mock omits status and exposes null array elements as Lua userdata.
    // Redis exposes missing HMGET fields as false, just like scalar HGET.
    redis.status = 'ready';
    const evaluate = redis.eval.bind(redis);
    redis.eval = (script, ...args) => evaluate(`
      local original_call = redis.call
      redis.call = function(command, ...)
        if command == 'HMGET' then
          local args = {...}
          local result = {}
          for i = 2, #args do result[i - 1] = original_call('HGET', args[1], args[i]) end
          return result
        end
        return original_call(command, ...)
      end
    ` + script, ...args);
    await redis.flushall();
  });
  afterEach(async () => { await redis.quit(); });

  it('shares reservations across members of one workspace and isolates other workspaces', async () => {
    const first = budget();
    const otherActor = context();
    otherActor.userId = 'another-user';
    otherActor.member.id = 'another-member';
    otherActor.member.role = 'admin';
    const second = budget({ context: otherActor });
    const ticket = await first.reserve({ tokens: 700 });
    await expect(second.reserve({ tokens: 301 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
    const last = await second.reserve({ tokens: 300 });
    expect(keyOf(last)).toBe(keyOf(ticket));
    expect(await redis.hget(keyOf(ticket), 'used')).toBe('1000');
    await expect(budget({ context: context(OTHER_WORKSPACE_ID) }).reserve({ tokens: 1000 })).resolves.toMatchObject({
      workspaceId: OTHER_WORKSPACE_ID, reservedTokens: 1000,
    });
  });

  it('admits only reservations fitting the allowance when requests overlap', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => budget().reserve({ tokens: 250 })));
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(4);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(4);
    const ticket = results.find(({ status }) => status === 'fulfilled').value;
    expect(await redis.hget(keyOf(ticket), 'used')).toBe('1000');
  });

  it('replaces reservations with actual usage exactly once, including a zero-token outcome', async () => {
    const service = budget();
    const first = await service.reserve({ tokens: 600 });
    const second = await service.reserve({ tokens: 300 });
    await expect(service.settle({ reservation: first, usage: usage(100) })).resolves.toEqual({ state: 'settled', usedTokens: 400, chargedTokens: 100 });
    await expect(service.settle({ reservation: first, usage: usage(900) })).resolves.toEqual({ state: 'settled', usedTokens: 400, chargedTokens: 100 });
    await expect(service.settle({ reservation: second, usage: usage(0) })).resolves.toEqual({ state: 'settled', usedTokens: 100, chargedTokens: 0 });
    await expect(service.reserve({ tokens: 900 })).resolves.toBeDefined();
  });

  it('holds unknown usage and allows later reconciliation', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 1000 });
    await expect(service.settle({ reservation })).resolves.toEqual({ state: 'held', usedTokens: 1000, chargedTokens: 1000 });
    await expect(service.reserve({ tokens: 1 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
    await service.settle({ reservation, usage: usage(10) });
    await expect(service.reserve({ tokens: 990 })).resolves.toBeDefined();
  });

  it('charges actual usage above an estimate and blocks further calls', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 500 });
    await expect(service.settle({ reservation, usage: usage(1100) })).resolves.toEqual({ state: 'settled', usedTokens: 1100, chargedTokens: 1100 });
    await expect(service.reserve({ tokens: 1 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
  });

  it('does not raise an active allowance during a rolling configuration change', async () => {
    const reservation = await budget().reserve({ tokens: 800 });
    await expect(budget({ limit: 2000 }).reserve({ tokens: 300 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
    await expect(budget({ limit: 700 }).reserve({ tokens: 1 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
    expect(await redis.hget(keyOf(reservation), 'limit')).toBe('700');
  });

  it('distinguishes a request larger than the allowance from temporary exhaustion', async () => {
    await expect(budget().reserve({ tokens: 1001 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_REQUEST_TOO_LARGE', statusCode: 422 });
    await budget().reserve({ tokens: 1000 });
    const error = await budget().reserve({ tokens: 1 }).catch((err) => err);
    expect(error).toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED', statusCode: 429 });
    expect(error.resetAtMs).toBeGreaterThan(Date.now());
    expect(normalizeProviderError(error).resetAtMs).toBe(error.resetAtMs);
    expect(JSON.stringify(error)).not.toContain('resetAtMs');
  });

  it('corrects a stale local window using Redis time', async () => {
    const ticket = await budget({ now: () => Date.now() - 2 * 86400000 }).reserve({ tokens: 1 });
    expect(ticket.windowStartMs).toBeLessThanOrEqual(Date.now());
    expect(ticket.resetAtMs).toBeGreaterThan(Date.now());
    expect(await redis.keys('kith:agent-budget:*')).toEqual([keyOf(ticket)]);
    const remaining = await redis.pttl(keyOf(ticket));
    expect(remaining).toBeGreaterThan(ticket.resetAtMs - Date.now());
    expect(remaining).toBeLessThanOrEqual(ticket.resetAtMs - Date.now() + TTL.AGENT_BUDGET_RETENTION_SECONDS * 1000 + 100);
  });

  it.each([
    ['day', '2028-02-29T23:59:59Z', '2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z'],
    ['month', '2028-02-29T23:59:59Z', '2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z'],
    ['month', '2026-12-31T23:59:59Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
  ])('uses UTC %s boundaries at %s', async (period, at, start, reset) => {
    const evalCommand = jest.fn().mockResolvedValue(['reserved', '10', '1000']);
    const ticket = await budget({ period, now: () => Date.parse(at), redisFactory: () => ({ status: 'ready', eval: evalCommand }) }).reserve({ tokens: 10 });
    expect(ticket).toMatchObject({ windowStartMs: Date.parse(start), resetAtMs: Date.parse(reset), period });
  });

  it('reconciles an old window without charging the new window', async () => {
    const service = budget();
    const current = await service.reserve({ tokens: 500 });
    const previous = { ...current, windowStartMs: current.windowStartMs - 86400000, resetAtMs: current.windowStartMs };
    await redis.hset(keyOf(previous), 'used', '500', 'limit', '1000', `r:${previous.id}`, 'p:500');
    await service.settle({ reservation: previous, usage: usage(50) });
    expect(await redis.hget(keyOf(previous), 'used')).toBe('50');
    expect(await redis.hget(keyOf(current), 'used')).toBe('500');
  });

  it.each([null, {}, { status: 'reconnecting', eval: jest.fn() }, { status: 'ready' }])('skips accounting when Redis is unavailable: %p', async (client) => {
    const service = budget({ redisFactory: () => client });
    await expect(service.reserve({ tokens: 10 })).resolves.toBeNull();
    await expect(service.settle({ reservation: null, usage: usage(10) })).resolves.toEqual({ state: 'unavailable' });
    expect(logger.warn).toHaveBeenCalledWith('Agent token budget unavailable; continuing without accounting', expect.objectContaining({ workspaceId: WORKSPACE_ID }));
    if (client?.eval) expect(client.eval).not.toHaveBeenCalled();
  });

  it.each(['factory', 'command'])('allows continuation after a %s failure without logging error details', async (kind) => {
    const failure = new Error('SECRET_REDIS_URL');
    const service = budget({ redisFactory: () => {
      if (kind === 'factory') throw failure;
      return { status: 'ready', eval: jest.fn().mockRejectedValue(failure) };
    } });
    await expect(service.reserve({ tokens: 1 })).resolves.toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET_REDIS_URL');
  });

  it('bounds a hanging command and safely handles a late rejection', async () => {
    let rejectCommand;
    const service = budget({ timeoutMs: 10, redisFactory: () => ({ status: 'ready', eval: () => new Promise((resolve, reject) => { rejectCommand = reject; }) }) });
    await expect(service.reserve({ tokens: 1 })).resolves.toBeNull();
    rejectCommand(new Error('late failure'));
    await Promise.resolve();
  });

  it('keeps a reservation after settlement outage and can reconcile after recovery', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 500 });
    const originalEval = redis.eval;
    redis.eval = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(service.settle({ reservation, usage: usage(50) })).resolves.toEqual({ state: 'unavailable' });
    expect(await redis.hget(keyOf(reservation), 'used')).toBe('500');
    redis.eval = originalEval;
    await expect(service.settle({ reservation, usage: usage(50) })).resolves.toMatchObject({ state: 'settled', chargedTokens: 50 });
  });

  it('does not invent accounting when Redis recovers after a skipped reservation', async () => {
    const service = budget({ redisFactory: () => null });
    const reservation = await service.reserve({ tokens: 10 });
    await expect(budget().settle({ reservation, usage: usage(9) })).resolves.toEqual({ state: 'unavailable' });
    expect(await redis.keys('kith:agent-budget:*')).toEqual([]);
  });

  it.each([undefined, {}, { ...context(), member: { ...context().member, isActive: false } }, context('not-a-uuid')])('requires an authenticated active workspace: %p', (actor) => {
    expect(() => budget({ context: actor })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('pins the workspace identity and rejects settlement for another workspace', async () => {
    const actor = context();
    const service = budget({ context: actor });
    actor.workspace.id = OTHER_WORKSPACE_ID;
    const reservation = await service.reserve({ tokens: 20 });
    expect(reservation.workspaceId).toBe(WORKSPACE_ID);
    await expect(budget({ context: context(OTHER_WORKSPACE_ID) }).settle({ reservation })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([{ limit: 0 }, { limit: 1.5 }, { limit: 1000000001 }, { period: 'week' }, { timeoutMs: 0 }, { redisFactory: null }])('rejects invalid configuration: %p', (options) => {
    expect(() => budget(options)).toThrow(expect.objectContaining({ code: 'AGENT_BUDGET_CONFIGURATION' }));
  });

  it.each([-1, 1.5, NaN, Infinity, '100', 1000000001])('rejects invalid reservations: %p', async (tokens) => {
    await expect(budget().reserve({ tokens })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await redis.keys('kith:agent-budget:*')).toEqual([]);
  });

  it('validates settlement windows and usage before changing the balance', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 20 });
    await expect(service.settle({ reservation: { ...reservation, resetAtMs: reservation.resetAtMs + 1 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.settle({ reservation, usage: { ...usage(10), totalTokens: 11 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await redis.hget(keyOf(reservation), 'used')).toBe('20');
  });

  it('rejects unknown reservation IDs without recreating expired counters', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 20 });
    await redis.del(keyOf(reservation));
    await expect(service.settle({ reservation, usage: usage(10) })).rejects.toMatchObject({ code: 'AGENT_BUDGET_UNAVAILABLE' });
    expect(await redis.keys('kith:agent-budget:*')).toEqual([]);
  });

  it.each(['not-a-count', '-1', '9007199254740992'])('does not treat a corrupt counter as zero: %s', async (value) => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 1 });
    await redis.hset(keyOf(reservation), 'used', value);
    await expect(service.reserve({ tokens: 1 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_UNAVAILABLE' });
  });

  it('blocks further reservations if actual usage overflows a safe integer', async () => {
    const service = budget();
    const reservation = await service.reserve({ tokens: 1 });
    await service.reserve({ tokens: 2 });
    await expect(service.settle({ reservation, usage: usage(Number.MAX_SAFE_INTEGER) })).rejects.toMatchObject({ code: 'AGENT_BUDGET_UNAVAILABLE' });
    await expect(service.reserve({ tokens: 1 })).rejects.toMatchObject({ code: 'AGENT_BUDGET_EXHAUSTED' });
  });
});
