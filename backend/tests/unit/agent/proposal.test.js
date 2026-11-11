jest.mock('../../../src/services/member.service', () => ({ getActiveMembership: jest.fn() }));
jest.mock('../../../src/services/notification_inbox.service', () => ({
  getNotification: jest.fn(), listUnreadNotificationIds: jest.fn(), getNotificationsByIds: jest.fn(),
  markAsRead: jest.fn(), markAllAsRead: jest.fn(),
}));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
const Redis = require('ioredis-mock');
const { randomUUID } = require('crypto');
const { createNotificationProposal, decideProposal } = require('../../../src/agent/services/proposal.service');
const { selectNotification, applyNotificationRead } = require('../../../src/agent/services/notification-proposal.service');
const { PROPOSAL_LIMITS } = require('../../../src/agent/validators/proposal.validator');
const { AppError, ConflictError } = require('../../../src/utils/errors');
const inbox = require('../../../src/services/notification_inbox.service');
const members = require('../../../src/services/member.service');
const audit = require('../../../src/services/audit.service');
const {
  context, snapshot, row, secondRow, member, OTHER_ID, SECOND_NOTIFICATION_ID,
} = require('../../helpers/agent-proposal');

describe('notification proposals and decisions', () => {
  let redis;
  const actorCtx = { actorUserId: OTHER_ID, ipAddress: '127.0.0.1', userAgent: 'test-agent' };
  const create = (overrides = {}) => createNotificationProposal({ context: context(), selection: snapshot(), args: {}, turnId: randomUUID(), actorCtx, redisFactory: () => redis, ...overrides });
  const createAll = (overrides = {}) => createNotificationProposal({ context: context(), tool: 'mark_all_notifications_read', args: {}, turnId: randomUUID(), actorCtx, redisFactory: () => redis, ...overrides });
  const decide = (proposal, overrides = {}) => decideProposal({ context: context(), proposalId: proposal.id, data: {}, decision: 'approve', actorCtx, redisFactory: () => redis, ...overrides });
  const recordKey = async () => (await redis.keys('kith:agent-proposal:*'))[0];
  beforeEach(() => {
    redis = new Redis();
    members.getActiveMembership.mockReset().mockResolvedValue(member());
    inbox.getNotification.mockReset().mockImplementation(async () => row());
    inbox.listUnreadNotificationIds.mockReset().mockResolvedValue({ notification_ids: [snapshot().id, SECOND_NOTIFICATION_ID], count: 2 });
    inbox.getNotificationsByIds.mockReset().mockResolvedValue([row(), secondRow()]);
    inbox.markAsRead.mockReset().mockResolvedValue({ ...row(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' });
    inbox.markAllAsRead.mockReset().mockResolvedValue({
      updated_count: 2,
      notifications: [
        { ...row(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' },
        { ...secondRow(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' },
      ],
    });
    audit.log.mockReset().mockResolvedValue();
  });
  afterEach(async () => { await redis.flushall(); await redis.quit(); jest.useRealTimers(); });

  it('creates an immutable, scoped, audited card without executing a write', async () => {
    const proposal = await create();
    expect(proposal).toMatchObject({ tool: 'mark_notification_read', tier: 2, parameters: { notification_id: snapshot().id }, before: snapshot(), after: { is_read: true } });
    expect(Date.parse(proposal.expires_at) - Date.now()).toBeLessThanOrEqual(PROPOSAL_LIMITS.expiryMs);
    expect(inbox.markAsRead).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      required: true, action: 'agent.action_proposed', actorUserId: context().userId, actorMemberId: context().member.id,
      workspaceId: context().workspace.id, targetId: snapshot().id, ipAddress: '127.0.0.1',
      metadata: expect.objectContaining({ agent_initiated: true, parameters: { notification_id: snapshot().id } }),
    }));
    const stored = JSON.parse(await redis.get(await recordKey()));
    expect(stored.state).toBe('pending');
    expect(await redis.ttl(await recordKey())).toBeGreaterThan(PROPOSAL_LIMITS.expiryMs / 1000);
    proposal.parameters.notification_id = OTHER_ID;
    expect(JSON.parse(await redis.get(await recordKey())).proposal.parameters.notification_id).toBe(snapshot().id);
  });

  it('binds mark-all approval to the exact current unread set without executing it', async () => {
    const proposal = await createAll();
    expect(proposal).toMatchObject({
      tool: 'mark_all_notifications_read', tier: 2,
      summary: 'Mark 2 currently unread notifications as read.',
      parameters: { notification_ids: [snapshot().id, SECOND_NOTIFICATION_ID] },
      before: { unread_count: 2 }, after: { unread_count: 0 },
    });
    expect(inbox.listUnreadNotificationIds).toHaveBeenCalledWith({
      memberId: context().member.id, workspaceId: context().workspace.id,
      limit: PROPOSAL_LIMITS.bulkNotificationIds,
    });
    expect(inbox.markAllAsRead).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agent.action_proposed', targetType: 'notification', targetId: null,
      metadata: expect.objectContaining({ tool: 'mark_all_notifications_read', parameters: proposal.parameters }),
    }));
  });

  it('marks only the saved unread IDs and returns an idempotent bulk receipt', async () => {
    const proposal = await createAll();
    // A later notification is deliberately absent from the saved parameters.
    inbox.listUnreadNotificationIds.mockResolvedValue({ notification_ids: [...proposal.parameters.notification_ids, OTHER_ID], count: 3 });
    const first = await decide(proposal);
    expect(await decide(proposal)).toEqual(first);
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: { notification_count: 2, updated_count: 2 } });
    expect(inbox.getNotificationsByIds).toHaveBeenCalledWith({
      notificationIds: proposal.parameters.notification_ids,
      memberId: context().member.id, workspaceId: context().workspace.id,
    });
    expect(inbox.markAllAsRead).toHaveBeenCalledTimes(1);
    expect(inbox.markAllAsRead).toHaveBeenCalledWith({
      notificationIds: proposal.parameters.notification_ids,
      memberId: context().member.id, workspaceId: context().workspace.id,
    });
  });

  it('does not create an empty or unbounded mark-all proposal', async () => {
    inbox.listUnreadNotificationIds.mockResolvedValueOnce({ notification_ids: [], count: 0 });
    await expect(createAll()).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    inbox.listUnreadNotificationIds.mockResolvedValueOnce({
      notification_ids: Array.from({ length: PROPOSAL_LIMITS.bulkNotificationIds }, () => randomUUID()),
      count: PROPOSAL_LIMITS.bulkNotificationIds + 1,
    });
    await expect(createAll()).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    expect(inbox.markAllAsRead).not.toHaveBeenCalled();
  });

  it('rejects a stale bound set before a bulk write', async () => {
    const proposal = await createAll();
    inbox.getNotificationsByIds.mockResolvedValue([{ ...row(), is_read: true, read_at: '2026-11-10T12:00:00.000Z' }, secondRow()]);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(JSON.parse(await redis.get(await recordKey())).state).toBe('failed');
    expect(inbox.markAllAsRead).not.toHaveBeenCalled();
  });

  it('never repeats a bulk update whose final state could not be confirmed', async () => {
    const proposal = await createAll();
    inbox.markAllAsRead.mockRejectedValueOnce(new AppError('Unknown', 503, 'NOTIFICATIONS_UPDATE_UNCONFIRMED'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(inbox.markAllAsRead).toHaveBeenCalledTimes(1);
  });

  it('executes only on approval, passing the exact snapshot and returning the same receipt on retry', async () => {
    const proposal = await create();
    const first = await decide(proposal);
    const second = await decide(proposal);
    expect(first).toEqual(second);
    expect(first).toEqual({ proposal_id: proposal.id, status: 'executed', result: { notification_id: snapshot().id, is_read: true, read_at: '2026-11-10T12:00:00.000Z' } });
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
    expect(inbox.markAsRead).toHaveBeenCalledWith({ notificationId: snapshot().id, memberId: context().member.id, workspaceId: context().workspace.id, expectedNotification: snapshot() });
    expect(audit.log.mock.calls.map(([entry]) => entry.action)).toEqual(['agent.action_proposed', 'agent.action_approved', 'agent.action_executed']);
  });

  it('keeps rejection final and idempotent', async () => {
    const proposal = await create();
    const first = await decide(proposal, { decision: 'reject' });
    expect(await decide(proposal, { decision: 'reject' })).toEqual(first);
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_DECIDED' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
    expect(audit.log.mock.calls.filter(([entry]) => entry.action === 'agent.action_rejected')).toHaveLength(1);
  });

  it.each(['user', 'workspace', 'member', 'role'])('does not reveal a proposal across %s scope', async (scope) => {
    const proposal = await create();
    const actor = context();
    if (scope === 'user') actor.userId = OTHER_ID;
    if (scope === 'workspace') { actor.workspace.id = OTHER_ID; actor.member.workspaceId = OTHER_ID; }
    if (scope === 'member') actor.member.id = OTHER_ID;
    if (scope === 'role') actor.member.role = 'admin';
    await expect(decide(proposal, { context: actor })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it.each([{ notification_id: OTHER_ID }, { parameters: {} }, { approved: true }, { role: 'admin' }, { tier: 1 }])('rejects approval parameter overrides: %j', async (data) => {
    const proposal = await create();
    await expect(decide(proposal, { data })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('rejects model-selected targets and inactive handler contexts', async () => {
    await expect(create({ args: { notification_id: OTHER_ID } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const actor = context(); actor.member.isActive = false;
    await expect(selectNotification({ context: actor, notificationId: snapshot().id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(applyNotificationRead({ context: actor, snapshot: snapshot() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(inbox.getNotification).not.toHaveBeenCalled();
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it.each([{ role: 'admin' }, { is_active: false }, { user_id: OTHER_ID }, { id: OTHER_ID }])('rechecks current membership rather than trusting cached identity: %j', async (change) => {
    const proposal = await create();
    members.getActiveMembership.mockResolvedValue({ ...member(), ...change });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('expires pending approvals without extending expiry on retries', async () => {
    const proposal = await create();
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(proposal.expires_at));
    try { await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_EXPIRED' }); }
    finally { Date.now.mockRestore(); }
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it.each([{ title: 'Changed title' }, { is_read: true, read_at: '2026-11-10T01:00:00Z' }, { type: 'other' }])('rejects stale preview data: %j', async (change) => {
    const proposal = await create();
    inbox.getNotification.mockResolvedValue({ ...row(), ...change });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(JSON.parse(await redis.get(await recordKey())).state).toBe('failed');
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('does not activate a proposal when required proposal auditing fails', async () => {
    audit.log.mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
    await expect(create()).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    const record = JSON.parse(await redis.get(await recordKey()));
    expect(record.state).toBe('preparing');
    await expect(decide(record.proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
  });

  it('allows approval-audit recovery before execution, using a stable event ID', async () => {
    const proposal = await create();
    audit.log.mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
    expect((await decide(proposal)).status).toBe('executed');
    const approvals = audit.log.mock.calls.filter(([entry]) => entry.action === 'agent.action_approved');
    expect(approvals[0][0].id).toBe(approvals[1][0].id);
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('retries final auditing without executing the notification write again', async () => {
    const proposal = await create();
    audit.log.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(JSON.parse(await redis.get(await recordKey())).state).toBe('applied');
    expect((await decide(proposal)).status).toBe('executed');
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
    const events = audit.log.mock.calls.filter(([entry]) => entry.action === 'agent.action_executed');
    expect(events[0][0].id).toBe(events[1][0].id);
  });

  it('recovers a rejected audit without ever allowing approval', async () => {
    const proposal = await create();
    audit.log.mockRejectedValueOnce(new AppError('Unavailable', 503, 'AUDIT_UNAVAILABLE'));
    await expect(decide(proposal, { decision: 'reject' })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_BUSY' });
    expect((await decide(proposal, { decision: 'reject' })).status).toBe('rejected');
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('executes at most once under concurrent approvals', async () => {
    const proposal = await create();
    const outcomes = await Promise.allSettled([decide(proposal), decide(proposal), decide(proposal)]);
    expect(outcomes.some((item) => item.status === 'fulfilled')).toBe(true);
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
    expect((await decide(proposal)).status).toBe('executed');
  });

  it('allows only one winner in an approve/reject race', async () => {
    const proposal = await create();
    const outcomes = await Promise.allSettled([decide(proposal), decide(proposal, { decision: 'reject' })]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const state = JSON.parse(await redis.get(await recordKey())).state;
    expect(inbox.markAsRead).toHaveBeenCalledTimes(state === 'executed' ? 1 : 0);
  });

  it('never reclaims an uncertain execution after a transport failure', async () => {
    const proposal = await create();
    inbox.markAsRead.mockRejectedValueOnce(new AppError('Unavailable', 503, 'NOTIFICATIONS_UNAVAILABLE'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('makes a conditional update conflict terminal without retrying the write', async () => {
    const proposal = await create();
    inbox.markAsRead.mockRejectedValueOnce(new ConflictError('Changed'));
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_STALE' });
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
  });

  it('does not execute after losing Redis state or when Redis is unavailable', async () => {
    const proposal = await create();
    await redis.del(await recordKey());
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_NOT_FOUND' });
    await expect(decide(proposal, { redisFactory: () => null })).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('rejects corrupt records instead of reconstructing a proposal from request data', async () => {
    const proposal = await create();
    await redis.set(await recordKey(), '{corrupt');
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it.each([false, true])('never repeats a write after the result-save acknowledgement is lost (saved=%s)', async (saved) => {
    const proposal = await create();
    const evaluate = redis.eval.bind(redis);
    jest.spyOn(redis, 'eval').mockImplementation(async (script, count, key, previous, next) => {
      if (JSON.parse(next).state === 'applied') {
        if (saved) await evaluate(script, count, key, previous, next);
        throw new Error('connection lost');
      }
      return evaluate(script, count, key, previous, next);
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    if (saved) expect((await decide(proposal)).status).toBe('executed');
    else await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(inbox.markAsRead).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.action_executed', metadata: expect.objectContaining({ execution_outcome: 'applied' }) }));
  });

  it('does not execute if Redis cannot acknowledge the irreversible claim', async () => {
    const proposal = await create();
    const evaluate = redis.eval.bind(redis);
    jest.spyOn(redis, 'eval').mockImplementation(async (script, count, key, previous, next) => {
      const reply = await evaluate(script, count, key, previous, next);
      if (JSON.parse(next).state === 'executing') throw new Error('acknowledgement lost');
      return reply;
    });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    await expect(decide(proposal)).rejects.toMatchObject({ code: 'AGENT_PROPOSAL_INDETERMINATE' });
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });

  it('bounds a stalled Redis read and never falls back to an untracked execution', async () => {
    const proposal = await create();
    jest.useFakeTimers();
    const assertion = expect(decide(proposal, { redisFactory: () => ({ status: 'ready', get: () => new Promise(() => {}) }) }))
      .rejects.toMatchObject({ code: 'AGENT_PROPOSAL_UNAVAILABLE' });
    await jest.advanceTimersByTimeAsync(PROPOSAL_LIMITS.redisTimeoutMs);
    await assertion;
    expect(inbox.markAsRead).not.toHaveBeenCalled();
  });
});
