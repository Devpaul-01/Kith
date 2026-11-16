const { createHash, randomUUID } = require('crypto');
const { AppError, ValidationError, ForbiddenError } = require('../../utils/errors');
const { getRedis } = require('../../config/redis');
const { agentProposalKey } = require('../../config/redis-keys');
const { withRedisDeadline } = require('../../utils/redis-deadline');
const audit = require('../../services/audit.service');
const { AUDIT_ACTIONS } = require('../../constants/audit-actions');
const { assertAgentContext } = require('./context.service');
const { assertNotCancelled } = require('../utils/cancellation');
const { assertCurrentActor } = require('./proposal-actor.service');
const proposals = require('./proposal-registry.service');
const {
  PROPOSAL_LIMITS, proposalRecordSchema, proposalSchema, proposalIdSchema,
  emptyApprovalSchema, secondaryConfirmationSchema, secondaryApprovalReplySchema,
  proposalStatusSchema, proposalReferencesSchema,
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
const uncertain = () => failure('AGENT_PROPOSAL_INDETERMINATE', 'The action result could not be confirmed. Check the affected data before requesting another action.', 409);

function freezeContext(context) {
  assertAgentContext(context);
  return Object.freeze({ userId: context.userId, requestId: context.requestId,
    member: Object.freeze({ ...context.member }), workspace: Object.freeze({ ...context.workspace }) });
}

function assertProposalRole(context, tool) {
  const definition = proposals.getDefinition(tool);
  if (!definition) throw unavailable();
  assertAgentContext(context, definition.minRole);
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
  async function transition(stored, state, result, patch = {}) {
    const record = { ...stored.record, ...patch, state, ...(result ? { result } : {}) };
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
  const domain = proposals.getDomain(record.proposal.tool);
  if (!domain) throw unavailable();
  const target = domain.getAuditTarget(record.proposal, context, record.result);
  await audit.log({
    id: record.auditIds[stage], required,
    workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
    ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    action: AUDIT_ACTIONS[`AGENT_ACTION_${stage.toUpperCase()}`],
    targetType: target.targetType, targetId: target.targetId,
    metadata: { agent_initiated: true, proposal_id: record.proposal.id, turn_id: record.turnId,
      tool: record.proposal.tool, tier: record.proposal.tier, parameters: record.proposal.parameters,
      ...(record.proposal.tier >= 3 ? { before: record.proposal.before, after: record.proposal.after } : {}),
      ...(record.proposal.tier === 4 ? { sensitive_action: true, secondary_confirmation_required: true,
        session_id: record.turnId, conversation_id: record.conversationId,
        secondary_confirmation: Boolean(record.secondaryConfirmation.confirmedAt),
        ...(record.secondaryConfirmation.confirmedAt ? {
          secondary_confirmed_at: record.secondaryConfirmation.confirmedAt, confirmation_method: 'typed',
        } : {}) } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(outcome ? { execution_outcome: outcome } : {}) },
  });
}

async function createProposal({ context, tool, selection, args, actorCtx, turnId, conversationId = null, signal, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  assertNotCancelled(signal);
  const domain = proposals.getDomain(tool);
  if (!domain) throw new ValidationError('Invalid proposal tool');
  assertProposalRole(actor, tool);
  const sensitive = proposals.getDefinition(tool).tier === 4;
  if (sensitive && (!proposalIdSchema.safeParse(turnId).success
      || (conversationId !== null && !proposalIdSchema.safeParse(conversationId).success))) {
    throw new ValidationError('A valid server-owned sensitive action trace is required');
  }
  const store = storage(actor, redisFactory);
  const proposal = proposalSchema.parse(await domain.createProposalDraft({
    context: actor, tool, selection, args, id: randomUUID(),
    expiresAt: new Date(Date.now() + PROPOSAL_LIMITS.expiryMs).toISOString(),
  }));
  assertNotCancelled(signal);
  let stored = await store.create({ version: 1, scope: store.scope, proposal, state: 'preparing', turnId,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed', ...(sensitive ? ['confirmed'] : [])]
      .map((stage) => [stage, randomUUID()])),
    ...(sensitive ? { conversationId: conversationId === null ? null : proposalIdSchema.parse(conversationId),
      secondaryConfirmation: { token: randomUUID() } } : {}),
  });
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'proposed' });
  assertNotCancelled(signal);
  stored = await store.transition(stored, 'pending');
  return stored.record.proposal;
}

function createNotificationProposal(options) {
  return createProposal({ tool: 'mark_notification_read', ...options });
}

function checkExpiry(record) {
  if (Date.parse(record.proposal.expires_at) <= Date.now()) {
    throw failure('AGENT_PROPOSAL_EXPIRED', 'This proposal expired. Please request a new one.', 410);
  }
}
const executedReply = (record) => ({ proposal_id: record.proposal.id, status: 'executed', result: record.result });
const rejectedReply = (record) => ({ proposal_id: record.proposal.id, status: 'rejected' });
// This token is returned only from explicit HTTP approval, never a status or
// model-facing receipt. It remains stable until the original card expires.
const secondaryApprovalReply = (record) => secondaryApprovalReplySchema.parse({
  proposal_id: record.proposal.id, status: 'awaiting_confirmation',
  confirmation_token: record.secondaryConfirmation.token, expires_at: record.proposal.expires_at,
});

function statusReply(record) {
  if (record.state === 'preparing') throw missing();
  const now = Date.now();
  const expired = Date.parse(record.proposal.expires_at) <= now;
  const statuses = {
    pending: expired ? 'expired' : 'pending', approving: expired ? 'expired' : 'approval_pending',
    awaiting_confirmation: expired ? 'expired' : 'awaiting_confirmation', confirming: expired ? 'expired' : 'confirmation_pending',
    executing: 'indeterminate', applied: 'audit_pending', executed: 'executed',
    rejecting: 'rejection_pending', rejected: 'rejected', failed: 'failed',
  };
  const domain = proposals.getDomain(record.proposal.tool);
  if (!domain) throw unavailable();
  const target = domain.getStatusTarget(record.proposal);
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
  await assertCurrentActor(actor);
  const stored = await storage(actor, redisFactory).read(id.data);
  assertProposalRole(actor, stored.record.proposal.tool);
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
  await assertCurrentActor(actor);
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
      assertProposalRole(actor, stored.record.proposal.tool);
      return statusReply(stored.record);
    } catch (err) {
      assertNotCancelled(signal);
      if (!['AGENT_PROPOSAL_NOT_FOUND', 'AGENT_PROPOSAL_UNAVAILABLE'].includes(err.code)) throw err;
      logger.warn('Agent action receipt unavailable', { requestId: actor.requestId, proposalId: proposal.id, errorCode: err.code });
      return unknown(proposal.id);
    }
  }));
}

async function revalidateApprovedProposal({ actor, actorCtx, store, stored }) {
  await assertCurrentActor(actor);
  const domain = proposals.getDomain(stored.record.proposal.tool);
  if (!domain) throw unavailable();
  try {
    await domain.revalidateProposal({ context: actor, proposal: stored.record.proposal });
  } catch (err) {
    if (['AGENT_PROPOSAL_STALE', 'NOT_FOUND'].includes(err?.code)) {
      stored = await store.transition(stored, 'failed');
      await logAction({ record: stored.record, context: actor, actorCtx, stage: 'failed', required: false, errorCode: err.code });
    }
    throw err;
  }
  checkExpiry(stored.record);
  return stored;
}

async function finishAppliedProposal({ actor, actorCtx, store, stored }) {
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'executed' });
  stored = await store.transition(stored, 'executed');
  return executedReply(stored.record);
}

async function executePreparedProposal({ actor, actorCtx, store, stored }) {
  const sensitive = stored.record.proposal.tier === 4;
  if (stored.record.state !== (sensitive ? 'confirming' : 'approving')) throw unavailable();
  const domain = proposals.getDomain(stored.record.proposal.tool);
  if (!domain) throw unavailable();
  checkExpiry(stored.record);
  stored = await store.transition(stored, 'executing');
  let result;
  try {
    result = await domain.applyProposal({ context: actor, proposal: stored.record.proposal,
      actorCtx: { workspaceId: actor.workspace.id, actorUserId: actor.userId, actorMemberId: actor.member.id,
        ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
      ...(sensitive ? { trace: { sessionId: stored.record.turnId, conversationId: stored.record.conversationId } } : {}),
    });
  } catch (err) {
    logger.warn('Agent proposal execution not confirmed', { proposalId: stored.record.proposal.id, errorCode: err?.code });
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'failed', required: false, errorCode: err?.code,
      outcome: err?.code === 'CONFLICT' ? 'not_applied' : 'unknown' });
    if (err?.code === 'CONFLICT') {
      await store.transition(stored, 'failed');
      throw failure('AGENT_PROPOSAL_STALE', 'The proposed data changed. Please request a new proposal.', 409);
    }
    throw uncertain();
  }
  // An uncertain save must never permit another mutation. Saved results can
  // finish their stable final audit through either appropriate retry endpoint.
  try { stored = await store.transition(stored, 'applied', result); } catch {
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'executed', required: false, outcome: 'applied' });
    throw uncertain();
  }
  return finishAppliedProposal({ actor, actorCtx, store, stored });
}

async function decideProposal({ context, proposalId, data, decision, actorCtx, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  const id = proposalIdSchema.safeParse(proposalId);
  if (!id.success || !emptyApprovalSchema.safeParse(data).success || !['approve', 'reject'].includes(decision)) {
    throw new ValidationError('Invalid proposal decision');
  }
  const store = storage(actor, redisFactory);
  let stored = await store.read(id.data);
  await assertCurrentActor(actor);
  assertProposalRole(actor, stored.record.proposal.tool);
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
    if (!['pending', 'awaiting_confirmation', 'rejecting'].includes(stored.record.state)) throw busy();
    if (stored.record.state !== 'rejecting') stored = await store.transition(stored, 'rejecting');
    await logAction({ record: stored.record, context: actor, actorCtx, stage: 'rejected' });
    stored = await store.transition(stored, 'rejected');
    return rejectedReply(stored.record);
  }
  if (stored.record.state === 'rejecting') throw busy();
  if (stored.record.state === 'applied') {
    return finishAppliedProposal({ actor, actorCtx, store, stored });
  }
  checkExpiry(stored.record);
  if (stored.record.proposal.tier === 4 && stored.record.state === 'awaiting_confirmation') {
    return secondaryApprovalReply(stored.record);
  }
  if (!['pending', 'approving'].includes(stored.record.state)) throw busy();
  if (stored.record.state === 'pending') stored = await store.transition(stored, 'approving');
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'approved' });
  stored = await revalidateApprovedProposal({ actor, actorCtx, store, stored });
  if (stored.record.proposal.tier === 4) {
    stored = await store.transition(stored, 'awaiting_confirmation');
    return secondaryApprovalReply(stored.record);
  }
  return executePreparedProposal({ actor, actorCtx, store, stored });
}

/** A separate authenticated typed confirmation is the only Tier 4 execution path. */
async function confirmProposal({ context, proposalId, data, actorCtx, redisFactory = getRedis }) {
  const actor = freezeContext(context);
  const id = proposalIdSchema.safeParse(proposalId);
  const confirmed = secondaryConfirmationSchema.safeParse(data);
  if (!id.success || !confirmed.success) throw new ValidationError('Invalid secondary confirmation');
  const store = storage(actor, redisFactory);
  let stored = await store.read(id.data);
  await assertCurrentActor(actor);
  assertProposalRole(actor, stored.record.proposal.tool);
  if (stored.record.proposal.tier !== 4) throw new ValidationError('This proposal does not require secondary confirmation');
  if (confirmed.data.confirmation_token !== stored.record.secondaryConfirmation.token) {
    throw new ForbiddenError('Invalid secondary confirmation token');
  }
  if (stored.record.state === 'executed') return executedReply(stored.record);
  if (stored.record.state === 'applied') return finishAppliedProposal({ actor, actorCtx, store, stored });
  if (stored.record.state === 'executing') throw uncertain();
  if (stored.record.state === 'failed') throw failure('AGENT_PROPOSAL_STALE', 'This proposal can no longer execute. Request a new one.', 409);
  if (stored.record.state === 'rejected') throw failure('AGENT_PROPOSAL_DECIDED', 'This proposal was rejected.', 409);
  if (stored.record.state === 'preparing') throw missing();
  if (['pending', 'approving'].includes(stored.record.state)) {
    throw failure('AGENT_PROPOSAL_CONFIRMATION_REQUIRED', 'Approve the card before confirming this sensitive action.', 409);
  }
  if (!['awaiting_confirmation', 'confirming'].includes(stored.record.state)) throw busy();
  checkExpiry(stored.record);
  if (stored.record.state === 'awaiting_confirmation') {
    stored = await store.transition(stored, 'confirming', undefined, {
      secondaryConfirmation: { ...stored.record.secondaryConfirmation, confirmedAt: new Date().toISOString() },
    });
  }
  await logAction({ record: stored.record, context: actor, actorCtx, stage: 'confirmed' });
  stored = await revalidateApprovedProposal({ actor, actorCtx, store, stored });
  return executePreparedProposal({ actor, actorCtx, store, stored });
}

module.exports = {
  createProposal,
  createNotificationProposal,
  decideProposal,
  confirmProposal,
  getProposalStatus,
  getProposalReceipts,
  CAS_PROPOSAL_SCRIPT,
};
