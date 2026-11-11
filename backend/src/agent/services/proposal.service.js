const { createHash, randomUUID } = require('crypto');
const { AppError, ValidationError } = require('../../utils/errors');
const { getRedis } = require('../../config/redis');
const { agentProposalKey } = require('../../config/redis-keys');
const { withRedisDeadline } = require('../../utils/redis-deadline');
const audit = require('../../services/audit.service');
const { AUDIT_ACTIONS } = require('../../constants/audit-actions');
const { assertAgentContext } = require('./context.service');
const { assertNotCancelled } = require('../utils/cancellation');
const notification = require('./notification-proposal.service');
const {
  PROPOSAL_LIMITS, proposalRecordSchema, proposalSchema, proposalIdSchema,
  emptyApprovalSchema, proposalStatusSchema, proposalReferencesSchema,
} = require('../validators/proposal.validator');
const logger = require('../../utils/logger');

// No claim can be reclaimed after entering executing. Redis uncertainty must
// never make a second process repeat a domain mutation.
const CAS_PROPOSAL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;
const failure = (code, message, status = 503) => new AppError(message, status, code);
const unavailable = () => failure('AGENT_PROPOSAL_UNAVAILABLE', 'The proposal is unavailable. Please try again.');
const missing = () => failure('AGENT_PROPOSAL_NOT_FOUND', 'Proposal not found or expired.', 404);
const busy = () => failure('AGENT_PROPOSAL_BUSY', 'This proposal is being processed. Retry to check its result.', 409);
const uncertain = () => failure('AGENT_PROPOSAL_INDETERMINATE', 'The action result could not be confirmed. Check your notifications before requesting another action.', 409);

function freezeContext(context) {
  assertAgentContext(context);
  return Object.freeze({ userId: context.userId, requestId: context.requestId,
    member: Object.freeze({ ...context.member }), workspace: Object.freeze({ ...context.workspace }) });
}

function storage(context, redisFactory) {
  const scope = createHash('sha256').update(JSON.stringify([context.userId, context.member.id, context.workspace.id, context.member.role])).digest('hex');
  let redis;
  try { redis = redisFactory(); } catch { throw unavailable(); }
  async function command(operation) {
    try { return await withRedisDeadline(redis, operation, PROPOSAL_LIMITS.redisTimeoutMs); } catch { throw unavailable(); }
  }
  function encode(record) {
    const parsed = proposalRecordSchema.safeParse(record);
    if (!parsed.success) throw unavailable();
    const raw = JSON.stringify(parsed.data);
    if (Buffer.byteLength(raw, 'utf8') > PROPOSAL_LIMITS.recordBytes) throw unavailable();
    return raw;
  }
  async function read(id) {
    const raw = await command(() => redis.get(agentProposalKey(scope, id)));
    if (raw === null) throw missing();
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > PROPOSAL_LIMITS.recordBytes) throw unavailable();
    let parsed;
    try { parsed = proposalRecordSchema.parse(JSON.parse(raw)); } catch { throw unavailable(); }
    if (parsed.scope !== scope || parsed.proposal.id !== id) throw missing();
    return { raw, record: parsed };
  }
  async function transition(stored, state, result) {
    const record = { ...stored.record, state, ...(result ? { result } : {}) };
    const raw = encode(record);
    const changed = await command(() => redis.eval(CAS_PROPOSAL_SCRIPT, 1, agentProposalKey(scope, record.proposal.id), stored.raw, raw));
    if (changed !== 1) throw busy();
    return { raw, record };
  }
  async function create(record) {
    const raw = encode(record);
    const result = await command(() => redis.set(agentProposalKey(scope, record.proposal.id), raw, 'EX', PROPOSAL_LIMITS.retentionSeconds, 'NX'));
    if (result !== 'OK') throw unavailable();
    return { raw, record };
  }
  return { scope, read, transition, create };
}

async function logAction({ record, context, actorCtx, stage, required = true, errorCode, outcome }) {
  // IDs always come from the authenticated context; only HTTP metadata is
  // taken from audit.fromReq. None of this metadata is offered to the model.
  await audit.log({
    id: record.auditIds[stage], required,
    workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
    ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    action: AUDIT_ACTIONS[`AGENT_ACTION_${stage.toUpperCase()}`], targetType: 'notification',
    targetId: notification.getAuditTarget(record.proposal),
    metadata: { agent_initiated: true, proposal_id: record.proposal.id, turn_id: record.turnId,
      tool: record.proposal.tool, tier: record.proposal.tier, parameters: record.proposal.parameters,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(outcome ? { execution_outcome: outcome } : {}) },
  });
}

async function createNotificationProposal({ context, tool = 'mark_notification_read', selection, args, actorCtx, turnId, signal, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  assertNotCancelled(signal);
  const store = storage(actor, redisFactory);
  const proposal = proposalSchema.parse(await notification.createProposalDraft({
    context: actor, tool, selection, args, id: randomUUID(),
    expiresAt: new Date(Date.now() + PROPOSAL_LIMITS.expiryMs).toISOString(),
  }));
  assertNotCancelled(signal);
  let stored = await store.create({ version: 1, scope: store.scope, proposal, state: 'preparing', turnId,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed'].map((stage) => [stage, randomUUID()])) });
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'proposed' });
  assertNotCancelled(signal);
  stored = await store.transition(stored, 'pending');
  return stored.record.proposal;
}

function checkExpiry(record) {
  if (Date.parse(record.proposal.expires_at) <= Date.now()) {
    throw failure('AGENT_PROPOSAL_EXPIRED', 'This proposal expired. Please request a new one.', 410);
  }
}
const executedReply = (record) => ({ proposal_id: record.proposal.id, status: 'executed', result: record.result });
const rejectedReply = (record) => ({ proposal_id: record.proposal.id, status: 'rejected' });

function statusReply(record) {
  if (record.state === 'preparing') throw missing();
  const now = Date.now();
  const expired = Date.parse(record.proposal.expires_at) <= now;
  const statuses = {
    pending: expired ? 'expired' : 'pending', approving: expired ? 'expired' : 'approval_pending',
    executing: 'indeterminate', applied: 'audit_pending', executed: 'executed',
    rejecting: 'rejection_pending', rejected: 'rejected', failed: 'failed',
  };
  const target = record.proposal.tool === 'mark_notification_read'
    ? { notification_id: record.proposal.parameters.notification_id }
    : { notification_count: record.proposal.parameters.notification_ids.length };
  return proposalStatusSchema.parse({
    proposal_id: record.proposal.id, tool: record.proposal.tool, ...target,
    status: statuses[record.state], expires_at: record.proposal.expires_at,
    checked_at: new Date(now).toISOString(), ...(record.result ? { result: record.result } : {}),
  });
}

/** Read a receipt only. Never audit, renew expiry, repair or execute an action. */
async function getProposalStatus({ context, proposalId, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  const id = proposalIdSchema.safeParse(proposalId);
  if (!id.success) throw new ValidationError('Invalid proposal ID');
  await notification.assertCurrentActor(actor);
  const stored = await storage(actor, redisFactory).read(id.data);
  return statusReply(stored.record);
}

/** Refresh a bounded set of server-owned proposal cards from recent history. */
async function getProposalReceipts({ context, proposals, signal, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  const input = proposalReferencesSchema.safeParse(proposals);
  if (!input.success) throw new ValidationError('Invalid proposal references');
  assertNotCancelled(signal);
  if (input.data.length === 0) return [];
  // Fresh membership failures must stop the turn, not become unknown receipts.
  await notification.assertCurrentActor(actor);
  assertNotCancelled(signal);
  const unknown = (id) => ({ proposal_id: id, status: 'unavailable', checked_at: new Date().toISOString() });
  let store;
  try { store = storage(actor, redisFactory); } catch {
    logger.warn('Agent action receipts unavailable', { requestId: actor.requestId, workspaceId: actor.workspace.id });
    return input.data.map((proposal) => unknown(proposal.id));
  }
  return Promise.all(input.data.map(async (proposal) => {
    assertNotCancelled(signal);
    try {
      const stored = await store.read(proposal.id);
      assertNotCancelled(signal);
      // The current record must describe the same card, not another target
      // attached to a valid-looking proposal ID in corrupt conversation data.
      if (JSON.stringify(stored.record.proposal) !== JSON.stringify(proposal)) throw unavailable();
      return statusReply(stored.record);
    } catch (err) {
      assertNotCancelled(signal);
      if (!['AGENT_PROPOSAL_NOT_FOUND', 'AGENT_PROPOSAL_UNAVAILABLE'].includes(err.code)) throw err;
      logger.warn('Agent action receipt unavailable', { requestId: actor.requestId, proposalId: proposal.id, errorCode: err.code });
      return unknown(proposal.id);
    }
  }));
}

async function decideProposal({ context, proposalId, data, decision, actorCtx, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  const id = proposalIdSchema.safeParse(proposalId);
  if (!id.success || !emptyApprovalSchema.safeParse(data).success || !['approve', 'reject'].includes(decision)) {
    throw new ValidationError('Invalid proposal decision');
  }
  const store = storage(actor, redisFactory);
  let stored = await store.read(id.data);
  await notification.assertCurrentActor(actor);
  if (stored.record.state === 'executed') {
    if (decision === 'reject') throw failure('AGENT_PROPOSAL_DECIDED', 'This proposal was already executed.', 409);
    return executedReply(stored.record);
  }
  if (stored.record.state === 'rejected') {
    if (decision === 'approve') throw failure('AGENT_PROPOSAL_DECIDED', 'This proposal was rejected.', 409);
    return rejectedReply(stored.record);
  }
  if (stored.record.state === 'executing') throw uncertain();
  if (stored.record.state === 'failed') throw failure('AGENT_PROPOSAL_STALE', 'This proposal can no longer execute. Request a new one.', 409);
  if (stored.record.state === 'preparing') throw missing();

  if (decision === 'reject') {
    if (!['pending', 'rejecting'].includes(stored.record.state)) throw busy();
    if (stored.record.state === 'pending') stored = await store.transition(stored, 'rejecting');
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'rejected' });
    stored = await store.transition(stored, 'rejected');
    return rejectedReply(stored.record);
  }
  if (stored.record.state === 'rejecting') throw busy();
  if (stored.record.state === 'applied') {
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'executed' });
    stored = await store.transition(stored, 'executed');
    return executedReply(stored.record);
  }
  checkExpiry(stored.record);
  if (stored.record.state === 'pending') stored = await store.transition(stored, 'approving');
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'approved' });
  await notification.assertCurrentActor(actor);
  try {
    await notification.revalidateProposal({ context: actor, proposal: stored.record.proposal });
  } catch (err) {
    if (['AGENT_PROPOSAL_STALE', 'NOT_FOUND'].includes(err.code)) {
      stored = await store.transition(stored, 'failed');
      await logAction({ record: stored.record, context: actor, actorCtx, stage: 'failed', required: false, errorCode: err.code });
    }
    throw err;
  }
  checkExpiry(stored.record);
  stored = await store.transition(stored, 'executing');
  let result;
  try {
    result = await notification.applyProposal({ context: actor, proposal: stored.record.proposal });
  } catch (err) {
    logger.warn('Agent proposal execution not confirmed', { proposalId: id.data, errorCode: err.code });
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'failed', required: false, errorCode: err.code,
      outcome: err.code === 'CONFLICT' ? 'not_applied' : 'unknown' });
    // A conditional conflict proves no row changed. Unknown transport failures
    // may follow a committed write and must keep the irreversible claim.
    if (err.code === 'CONFLICT') {
      await store.transition(stored, 'failed');
      throw failure('AGENT_PROPOSAL_STALE', 'The notification changed. Please request a new proposal.', 409);
    }
    throw uncertain();
  }
  // If this save is uncertain, do not execute again. If it succeeded, a retry
  // can finish the audit using its stable ID without repeating the mutation.
  try { stored = await store.transition(stored, 'applied', result); } catch {
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'executed', required: false, outcome: 'applied' });
    throw uncertain();
  }
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'executed' });
  stored = await store.transition(stored, 'executed');
  return executedReply(stored.record);
}

module.exports = { createNotificationProposal, decideProposal, getProposalStatus, getProposalReceipts, CAS_PROPOSAL_SCRIPT };
