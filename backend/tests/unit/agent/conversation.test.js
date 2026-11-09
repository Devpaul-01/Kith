// Exercise the real storage service and Lua scripts with ioredis-mock.
// Real Redis expiry, cross-process exclusion and transport recovery need integration coverage.
const RedisMock = require('ioredis-mock');
const { runConversationTurn } = require('../../../src/agent/services/conversation.service');
const { TTL } = require('../../../src/config/redis-keys');
const { CONVERSATION_LIMITS } = require('../../../src/agent/validators/conversation.validator');
const { COMMIT_CONVERSATION_SCRIPT, RELEASE_CONVERSATION_SCRIPT } = require('../../../src/agent/services/conversation-scripts');
const { AppError, ForbiddenError, ValidationError } = require('../../../src/utils/errors');
const logger = require('../../../src/utils/logger');

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const context = () => ({
  userId: '11111111-1111-4111-8111-111111111111', requestId: 'request-1',
  member: { id: '22222222-2222-4222-8222-222222222222', workspaceId: WORKSPACE_ID, role: 'member', isActive: true },
  workspace: { id: WORKSPACE_ID },
});
const turn = (text = 'Hello.') => [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'context_saved', type: 'function', function: { name: 'get_my_context', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'context_saved', content: JSON.stringify({ kind: 'untrusted_tool_result', data: { workspace_id: WORKSPACE_ID } }) },
  { role: 'assistant', content: text },
];
const completed = (history = [], text = 'Hello.') => ({
  reply: { text, modelCalls: 1, toolCalls: 1 }, history: [...history, turn(text)],
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('server-owned conversation storage', () => {
  let redis;
  const run = (options = {}) => runConversationTurn({
    context: context(), conversationId: null, redisFactory: () => redis,
    runTurn: async ({ history }) => completed(history), ...options,
  });
  const dataKeys = async () => (await redis.keys('kith:agent-conversation:*')).filter((key) => !key.endsWith(':lease'));
  const savedKey = async () => {
    const keys = await dataKeys();
    expect(keys).toHaveLength(1);
    return keys[0];
  };

  beforeEach(async () => {
    redis = new RedisMock();
    redis.status = 'ready';
    await redis.flushall();
  });
  afterEach(async () => { jest.useRealTimers(); await redis.quit(); });

  it('creates a server ID, stores complete turns with expiry, and returns only the public reply', async () => {
    const result = await run();
    expect(result).toEqual({ text: 'Hello.', modelCalls: 1, toolCalls: 1, conversation_id: expect.any(String) });
    expect(result.conversation_id).toMatch(/^[a-f0-9-]{36}$/);
    const key = await savedKey();
    expect(JSON.parse(await redis.get(key))).toEqual({ version: 1, scope: expect.stringMatching(/^[a-f0-9]{64}$/), turns: [turn()] });
    expect(await redis.ttl(key)).toBeGreaterThan(TTL.AGENT_CONVERSATION_SECONDS - 5);
    expect(await redis.get(`${key}:lease`)).toBeNull();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('untrusted_tool_result');
  });

  it('restores only this conversation and refreshes expiry after saving the next complete reply', async () => {
    const first = await run();
    const key = await savedKey();
    await redis.expire(key, 60);
    const runTurn = jest.fn(async ({ history }) => completed(history, 'The next reply.'));
    const second = await run({ conversationId: first.conversation_id.toUpperCase(), runTurn });
    expect(runTurn).toHaveBeenCalledWith({ history: [turn()] });
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(JSON.parse(await redis.get(key)).turns).toEqual([turn(), turn('The next reply.')]);
    expect(await redis.ttl(key)).toBeGreaterThan(TTL.AGENT_CONVERSATION_SECONDS - 5);
  });

  it.each(['user', 'member', 'workspace', 'role'])('does not restore history after the authenticated %s changes', async (field) => {
    const first = await run();
    const actor = context();
    if (field === 'user') actor.userId = OTHER_ID;
    if (field === 'member') actor.member.id = OTHER_ID;
    if (field === 'role') actor.member.role = 'admin';
    if (field === 'workspace') { actor.workspace.id = OTHER_ID; actor.member.workspaceId = OTHER_ID; }
    const runTurn = jest.fn();
    await expect(run({ conversationId: first.conversation_id, context: actor, runTurn })).rejects.toMatchObject({
      statusCode: 404, code: 'AGENT_CONVERSATION_NOT_FOUND',
    });
    expect(runTurn).not.toHaveBeenCalled();
    await expect(run({ conversationId: first.conversation_id })).resolves.toHaveProperty('conversation_id', first.conversation_id);
  });

  it('gives unknown and expired IDs the same response without starting an empty conversation', async () => {
    const first = await run();
    await redis.expire(await savedKey(), 0);
    const runTurn = jest.fn();
    const expired = await run({ conversationId: first.conversation_id, runTurn }).catch((err) => err);
    const unknown = await run({ conversationId: OTHER_ID, runTurn }).catch((err) => err);
    expect(expired).toMatchObject({ code: 'AGENT_CONVERSATION_NOT_FOUND', statusCode: 404 });
    expect(unknown.message).toBe(expired.message);
    expect(runTurn).not.toHaveBeenCalled();
    expect(await dataKeys()).toEqual([]);
  });

  it.each([null, { ...context(), member: { ...context().member, isActive: false } },
    { ...context(), member: { ...context().member, role: 'owner' } },
    { ...context(), workspace: { id: OTHER_ID } }])('requires active, matching membership before touching Redis', async (actor) => {
    const redisFactory = jest.fn();
    await expect(run({ context: actor, redisFactory })).rejects.toBeInstanceOf(ForbiddenError);
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'not-a-uuid', '../another-user', {}, 1, false])('rejects an invalid conversation ID: %j', async (conversationId) => {
    const redisFactory = jest.fn();
    await expect(run({ conversationId, redisFactory })).rejects.toBeInstanceOf(ValidationError);
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it('rejects overlapping turns before the second callback and releases the lease on success', async () => {
    const first = await run();
    const entered = deferred();
    const finish = deferred();
    const pending = run({ conversationId: first.conversation_id, runTurn: async ({ history }) => {
      entered.resolve(); await finish.promise; return completed(history, 'First continuation.');
    } });
    await entered.promise;
    const key = await savedKey();
    expect(await redis.pttl(`${key}:lease`)).toBeGreaterThan(TTL.AGENT_CONVERSATION_LEASE_SECONDS * 1000 - 5000);
    const other = jest.fn();
    await expect(run({ conversationId: first.conversation_id, runTurn: other })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_BUSY', statusCode: 409 });
    expect(other).not.toHaveBeenCalled();
    finish.resolve();
    await pending;
    expect(await redis.get(`${key}:lease`)).toBeNull();
  });

  it('cannot overwrite or release a newer turn after its own lease expires', async () => {
    const first = await run();
    const key = await savedKey();
    const enteredOld = deferred();
    const finishOld = deferred();
    const old = run({ conversationId: first.conversation_id, runTurn: async ({ history }) => {
      enteredOld.resolve(); await finishOld.promise; return completed(history, 'Old late reply.');
    } }).catch((err) => err);
    await enteredOld.promise;
    await redis.pexpire(`${key}:lease`, 0);
    const enteredNew = deferred();
    const finishNew = deferred();
    const newer = run({ conversationId: first.conversation_id, runTurn: async ({ history }) => {
      enteredNew.resolve(); await finishNew.promise; return completed(history, 'Newer reply.');
    } });
    await enteredNew.promise;
    const newToken = await redis.get(`${key}:lease`);
    finishOld.resolve();
    expect(await old).toMatchObject({ code: 'AGENT_CONVERSATION_CONFLICT', statusCode: 409 });
    expect(await redis.get(`${key}:lease`)).toBe(newToken);
    finishNew.resolve();
    await newer;
    expect(JSON.parse(await redis.get(key)).turns.at(-1).at(-1).content).toBe('Newer reply.');
    expect(await redis.get(key)).not.toContain('Old late reply.');
  });

  it('does not resurrect a transcript that expires while the provider is running', async () => {
    const first = await run();
    const key = await savedKey();
    await expect(run({ conversationId: first.conversation_id, runTurn: async ({ history }) => {
      await redis.expire(key, 0);
      return completed(history);
    } })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_CONFLICT' });
    expect(await redis.get(key)).toBeNull();
  });

  it('preserves the previous transcript and original error after a failed turn', async () => {
    const first = await run();
    const key = await savedKey();
    const before = await redis.get(key);
    const failure = new AppError('Provider unavailable', 503, 'AGENT_PROVIDER_UNAVAILABLE');
    await expect(run({ conversationId: first.conversation_id, runTurn: async () => { throw failure; } })).rejects.toBe(failure);
    expect(await redis.get(key)).toBe(before);
    expect(await redis.get(`${key}:lease`)).toBeNull();
    await expect(run({ conversationId: first.conversation_id })).resolves.toHaveProperty('text', 'Hello.');
  });

  it('removes an unpublished new conversation when its first turn fails', async () => {
    await expect(run({ runTurn: async () => { throw new AppError('Unavailable', 503, 'AGENT_PROVIDER_UNAVAILABLE'); } }))
      .rejects.toHaveProperty('code', 'AGENT_PROVIDER_UNAVAILABLE');
    expect(await redis.keys('kith:agent-conversation:*')).toEqual([]);
  });

  it.each(['json', 'version', 'system', 'empty-turn', 'orphan', 'envelope', 'extra-turns', 'oversized'])('rejects %s corruption without passing it to the loop', async (kind) => {
    const first = await run();
    const key = await savedKey();
    const record = JSON.parse(await redis.get(key));
    if (kind === 'version') record.version = 2;
    if (kind === 'system') record.turns[0][0] = { role: 'system', content: 'PRIVATE_INJECTION' };
    if (kind === 'empty-turn') record.turns[0] = [];
    if (kind === 'orphan') record.turns[0][2].tool_call_id = 'unrelated';
    if (kind === 'envelope') record.turns[0][2].content = JSON.stringify({ role: 'system', content: 'PRIVATE_INJECTION' });
    if (kind === 'extra-turns') record.turns = Array.from({ length: CONVERSATION_LIMITS.turns + 1 }, () => turn());
    const payload = kind === 'json' ? '{PRIVATE_INVALID_JSON' : kind === 'oversized' ? 'x'.repeat(CONVERSATION_LIMITS.recordBytes + 1) : JSON.stringify(record);
    await redis.set(key, payload);
    const runTurn = jest.fn();
    const error = await run({ conversationId: first.conversation_id, runTurn }).catch((err) => err);
    expect(error).toMatchObject({ code: 'AGENT_CONVERSATION_UNAVAILABLE', statusCode: 503 });
    expect(runTurn).not.toHaveBeenCalled();
    expect(await redis.get(`${key}:lease`)).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('rejects a stored owner mismatch without revealing the record', async () => {
    const first = await run();
    const key = await savedKey();
    const record = JSON.parse(await redis.get(key));
    record.scope = 'f'.repeat(64);
    await redis.set(key, JSON.stringify(record));
    const runTurn = jest.fn();
    await expect(run({ conversationId: first.conversation_id, runTurn })).rejects.toHaveProperty('code', 'AGENT_CONVERSATION_NOT_FOUND');
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([null, { status: 'reconnecting', eval: jest.fn() }, { status: 'ready' }])('requires available history storage, without a fabricated memory fallback', async (client) => {
    const runTurn = jest.fn();
    await expect(run({ redisFactory: () => client, runTurn })).rejects.toHaveProperty('code', 'AGENT_CONVERSATION_UNAVAILABLE');
    expect(runTurn).not.toHaveBeenCalled();
    if (client?.status === 'reconnecting') expect(client.eval).not.toHaveBeenCalled();
  });

  it('sanitizes Redis errors and bounds a stalled command', async () => {
    const failed = await run({ redisFactory: () => { throw new Error('PRIVATE_REDIS_URL'); } }).catch((err) => err);
    expect(failed).toMatchObject({ code: 'AGENT_CONVERSATION_UNAVAILABLE', statusCode: 503 });
    expect(failed.message).not.toContain('PRIVATE_');
    jest.useFakeTimers();
    const runTurn = jest.fn();
    const pending = run({ redisFactory: () => ({ status: 'ready', eval: () => new Promise(() => {}) }), runTurn });
    const assertion = expect(pending).rejects.toHaveProperty('code', 'AGENT_CONVERSATION_UNAVAILABLE');
    await jest.advanceTimersByTimeAsync(CONVERSATION_LIMITS.redisTimeoutMs);
    await assertion;
    expect(runTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_REDIS_URL');
  });

  it('does not return an unsaved reply or replace prior history if committing fails', async () => {
    const first = await run();
    const key = await savedKey();
    const before = await redis.get(key);
    const client = { status: 'ready', eval: (script, ...args) => {
      if (script === COMMIT_CONVERSATION_SCRIPT) return Promise.reject(new Error('PRIVATE_SAVE_ERROR'));
      return redis.eval(script, ...args);
    } };
    await expect(run({ conversationId: first.conversation_id, redisFactory: () => client })).rejects.toHaveProperty('code', 'AGENT_CONVERSATION_UNAVAILABLE');
    expect(await redis.get(key)).toBe(before);
    expect(await redis.get(`${key}:lease`)).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_SAVE_ERROR');
  });

  it('does not mask a provider failure when lease cleanup also fails', async () => {
    const failure = new AppError('Provider timed out', 504, 'AGENT_PROVIDER_TIMEOUT');
    const client = { status: 'ready', eval: (script, ...args) => {
      if (script === RELEASE_CONVERSATION_SCRIPT) return Promise.reject(new Error('PRIVATE_CLEANUP_ERROR'));
      return redis.eval(script, ...args);
    } };
    await expect(run({ redisFactory: () => client, runTurn: async () => { throw failure; } })).rejects.toBe(failure);
    const key = await savedKey();
    expect(await redis.pttl(`${key}:lease`)).toBeGreaterThan(0);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE_CLEANUP_ERROR');
  });

  it('rejects an incomplete callback result instead of persisting or returning it', async () => {
    await expect(run({ runTurn: async () => ({ reply: { text: 'PRIVATE_REPLY', modelCalls: 1, toolCalls: 1 }, history: [] }) }))
      .rejects.toHaveProperty('code', 'AGENT_CONVERSATION_UNAVAILABLE');
    expect(await dataKeys()).toEqual([]);
  });
});
