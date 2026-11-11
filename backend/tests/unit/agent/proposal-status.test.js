jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/notification_inbox.service', () => ({
  getNotification: jest.fn(), listUnreadNotificationIds: jest.fn(), getNotificationsByIds: jest.fn(),
  markAsRead: jest.fn(), markAllAsRead: jest.fn(),
}));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { createNotificationProposal, getProposalStatus, getProposalReceipts } = require('../../../src/agent/services/proposal.service');
const { PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { AppError } = require('../../../src/utils/errors');
const inbox = require('../../../src/services/notification_inbox.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const { context, snapshot, row, member, OTHER_ID, SECOND_NOTIFICATION_ID } = require('../../helpers/agent-proposal');

describe('read-only proposal receipts', () => {
  let redis;
  let proposal;
  let key;
  const result = { notification_id: snapshot().id, is_read: true, read_at: '2026-11-10T12:00:00.000Z' };
  const status = (overrides = {}) => getProposalStatus({ context: context(), proposalId: proposal.id, redisFactory: () => redis, ...overrides });
  const receipts = (overrides = {}) => getProposalReceipts({ context: context(), proposals: [proposal], redisFactory: () => redis, ...overrides });
  async function changeRecord(change) {
    const record = JSON.parse(await redis.get(key));
    await redis.set(key, JSON.stringify({ ...record, ...change }), 'EX', PROPOSAL_LIMITS.retentionSeconds);
  }
  function watchWrites() {
    return [jest.spyOn(redis, 'set'), jest.spyOn(redis, 'eval'), jest.spyOn(redis, 'expire'), audit.log,
      inbox.getNotification, inbox.listUnreadNotificationIds, inbox.getNotificationsByIds, inbox.markAsRead, inbox.markAllAsRead];
  }
  beforeEach(async () => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    inbox.getNotification.mockReset().mockResolvedValue(row());
    inbox.listUnreadNotificationIds.mockReset().mockResolvedValue({ notification_ids: [snapshot().id, SECOND_NOTIFICATION_ID], count: 2 });
    inbox.getNotificationsByIds.mockReset();
    inbox.markAsRead.mockReset();
    inbox.markAllAsRead.mockReset();
    audit.log.mockReset().mockResolvedValue();
    proposal = await createNotificationProposal({ context: context(), selection: snapshot(), args: {}, turnId: randomUUID(), redisFactory: () => redis });
    [key] = await redis.keys('kith:agent-proposal:*');
    jest.clearAllMocks();
  });
  afterEach(async () => { await redis.flushall(); await redis.quit(); jest.restoreAllMocks(); jest.useRealTimers(); });

  it.each([
    ['pending', 'pending'], ['approving', 'approval_pending'], ['executing', 'indeterminate'],
    ['applied', 'audit_pending'], ['executed', 'executed'], ['rejecting', 'rejection_pending'],
    ['rejected', 'rejected'], ['failed', 'failed'],
  ])('reads %s as %s without executing, repairing audit or renewing storage', async (state, expected) => {
    await changeRecord({ state, ...(['applied', 'executed'].includes(state) ? { result } : {}) });
    const before = await redis.get(key);
    const ttl = await redis.pttl(key);
    const writes = watchWrites();
    const receipt = await status({ proposalId: proposal.id.toUpperCase() });
    expect(receipt).toEqual({ proposal_id: proposal.id, tool: proposal.tool, notification_id: snapshot().id,
      status: expected, expires_at: proposal.expires_at, checked_at: expect.any(String),
      ...(['applied', 'executed'].includes(state) ? { result } : {}) });
    expect(await receipts()).toEqual([{ ...receipt, checked_at: expect.any(String) }]);
    expect(members.getActiveMembership).toHaveBeenCalledTimes(2);
    expect(await redis.get(key)).toBe(before);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(ttl);
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it('returns a bulk proposal receipt without loading or changing notifications', async () => {
    await redis.flushall();
    proposal = await createNotificationProposal({
      context: context(), tool: 'mark_all_notifications_read', args: {},
      turnId: randomUUID(), redisFactory: () => redis,
    });
    key = (await redis.keys('kith:agent-proposal:*')).find((candidate) => candidate.endsWith(proposal.id));
    const bulkResult = { notification_count: 2, updated_count: 2 };
    await changeRecord({ state: 'executed', result: bulkResult });
    jest.clearAllMocks();
    const writes = watchWrites();
    await expect(status()).resolves.toEqual({
      proposal_id: proposal.id, tool: 'mark_all_notifications_read', notification_count: 2,
      status: 'executed', expires_at: proposal.expires_at, checked_at: expect.any(String), result: bulkResult,
    });
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it.each(['pending', 'approving', 'executing', 'applied', 'executed', 'rejected'])('expiry does not erase the outcome of %s', async (state) => {
    await changeRecord({ state, ...(['applied', 'executed'].includes(state) ? { result } : {}) });
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(proposal.expires_at));
    const expected = { pending: 'expired', approving: 'expired', executing: 'indeterminate', applied: 'audit_pending', executed: 'executed', rejected: 'rejected' };
    expect((await status()).status).toBe(expected[state]);
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it.each(['user', 'member', 'workspace', 'role'])('does not expose receipts across %s scope', async (scope) => {
    const actor = context();
    if (scope === 'user') actor.userId = OTHER_ID;
    if (scope === 'member') actor.member.id = OTHER_ID;
    if (scope === 'workspace') { actor.workspace.id = OTHER_ID; actor.member.workspaceId = OTHER_ID; }
    if (scope === 'role') actor.member.role = 'admin';
    members.getActiveMembership.mockResolvedValue({ ...member(), id: actor.member.id, user_id: actor.userId, workspace_id: actor.workspace.id, role: actor.member.role });
    await expect(status({ context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    expect(await receipts({ context: actor })).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  });

  it.each([{ role: 'admin' }, { is_active: false }, { id: OTHER_ID }, { user_id: OTHER_ID }, { workspace_id: OTHER_ID }])('blocks fresh membership mismatch: %j', async (change) => {
    members.getActiveMembership.mockResolvedValue({ ...member(), ...change });
    const get = jest.spyOn(redis, 'get');
    await expect(status()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(receipts()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(get).not.toHaveBeenCalled();
  });

  it('propagates membership outages instead of labeling receipts unavailable', async () => {
    members.getActiveMembership.mockRejectedValue(new AppError('Unavailable', 503, 'MEMBERS_UNAVAILABLE'));
    await expect(receipts()).rejects.toMatchObject({ code: 'MEMBERS_UNAVAILABLE' });
    await expect(status()).rejects.toMatchObject({ code: 'MEMBERS_UNAVAILABLE' });
  });

  it.each(['missing', 'preparing', 'corrupt', 'wrong-result', 'oversized', 'unavailable'])('never infers an outcome from a %s record', async (failure) => {
    let redisFactory = () => redis;
    if (failure === 'missing') await redis.del(key);
    if (failure === 'preparing') await changeRecord({ state: 'preparing' });
    if (failure === 'corrupt') await redis.set(key, '{broken');
    if (failure === 'oversized') await redis.set(key, 'x'.repeat(PROPOSAL_LIMITS.recordBytes + 1));
    if (failure === 'wrong-result') await changeRecord({ state: 'executed', result: { ...result, notification_id: OTHER_ID } });
    if (failure === 'unavailable') redisFactory = () => { throw new Error('Redis unavailable'); };
    const writes = watchWrites();
    await expect(status({ redisFactory })).rejects.toMatchObject({ code: ['missing', 'preparing'].includes(failure) ? 'AGENT_PROPOSAL_NOT_FOUND' : 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(await receipts({ redisFactory })).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
    writes.forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it('compares the complete saved card and does not trust a matching ID with changed fields', async () => {
    await changeRecord({ state: 'executed', result });
    const changed = { ...proposal, before: { ...proposal.before, title: 'Altered historical title' } };
    expect(await receipts({ proposals: [changed] })).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  });

  it('refreshes multiple cards with one membership check and keeps a missing result explicit', async () => {
    const other = { ...proposal, id: OTHER_ID };
    expect(await receipts({ proposals: [proposal, other] })).toEqual([
      expect.objectContaining({ proposal_id: proposal.id, status: 'pending' }),
      { proposal_id: OTHER_ID, status: 'unavailable', checked_at: expect.any(String) },
    ]);
    expect(members.getActiveMembership).toHaveBeenCalledTimes(1);
  });

  it('does no work for empty references and rejects invalid, duplicate or unbounded input', async () => {
    const redisFactory = jest.fn(() => redis);
    expect(await receipts({ proposals: [], redisFactory })).toEqual([]);
    for (const proposals of [[proposal.id], [proposal, proposal], Array.from({ length: 9 }, () => ({ ...proposal, id: randomUUID() }))]) {
      await expect(receipts({ proposals, redisFactory })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(status({ proposalId: 'bad-id', redisFactory })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(members.getActiveMembership).not.toHaveBeenCalled();
    expect(redisFactory).not.toHaveBeenCalled();
  });

  it('bounds stalled receipt reads and preserves an explicit unavailable outcome', async () => {
    jest.useFakeTimers();
    const pending = receipts({ redisFactory: () => ({ status: 'ready', get: () => new Promise(() => {}) }) });
    await jest.advanceTimersByTimeAsync(PROPOSAL_LIMITS.redisTimeoutMs);
    expect(await pending).toEqual([{ proposal_id: proposal.id, status: 'unavailable', checked_at: expect.any(String) }]);
  });

  it.each(['before', 'membership', 'read'])('honors cancellation %s without returning stale receipts', async (stage) => {
    const controller = new AbortController();
    if (stage === 'before') controller.abort();
    if (stage === 'membership') members.getActiveMembership.mockImplementation(async () => { controller.abort(); return member(); });
    if (stage === 'read') jest.spyOn(redis, 'get').mockImplementation(async () => { controller.abort(); return null; });
    await expect(receipts({ signal: controller.signal })).rejects.toMatchObject({ code: 'AGENT_REQUEST_CANCELLED' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });
});
