const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { disputeEntryState, disputeExecutionTraceSchema } = require('../../validators/dispute-raise.validator');
const { disputeResolutionState, resolutionContextMatches } = require('../../validators/dispute-resolve.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, resolveDisputeTargetSchema, resolveDisputeContextSchema, resolveDisputeArgumentsSchema,
  resolveDisputeResultSchema, resolveDisputeParametersFromArgs, resolveDisputeAfter, resolveDisputeResultMatches,
  DISPUTE_RESOLVE_SUMMARY, SECONDARY_CONFIRMATION, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const resolveDisputeDefinition = Object.freeze({
  name: 'resolve_dispute', tier: 4, minRole: 'admin',
  description: 'Propose resolving the exact open dispute explicitly selected for this message. Admin only. Supply only the requested resolution_note, trimmed to 10–1000 characters; clarify a missing or ambiguous note. The dispute must be raised by its active non-proxy contribution owner. Its disputed positive non-crypto contribution must have recorded confirmation metadata, use the workspace base currency and have no recurring cycle or correction link in an active money-enabled event. The full Tier 4 card binds the immutable financial fields, existing dispute details, exact resolution note and authenticated resolver. Both dispute and contribution become resolved; amounts and confirmation details are preserved. Mutable proofs and appended dispute notes are outside this approval. Postgres returns the real resolution time. Separate approval requires a distinct authenticated typed confirm request before execution; chat text never approves or confirms. Other selections, history, search candidates and IDs in prose cannot choose a target. Bulk resolution, proxies, on-behalf disputes, corrections and financial edits are unavailable.',
  parameterSchema: resolveDisputeArgumentsSchema,
});
const definitions = Object.freeze([resolveDisputeDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role || !resolutionContextMatches(selection)) {
    throw new ForbiddenError('Dispute resolution must use the authenticated admin and reviewed contribution');
  }
}
async function readSelection({ context, disputeId }) {
  assertAgentContext(context, 'admin');
  const target = resolveDisputeTargetSchema.safeParse({ dispute_id: disputeId });
  if (!target.success) throw new ValidationError('Invalid dispute resolution selection');
  const disputes = require('../../services/dispute.service');
  const selected = resolveDisputeContextSchema.safeParse(await disputes.getResolveDisputeContext({
    workspaceId: context.workspace.id, disputeId: target.data.dispute_id,
    callerId: context.member.id, userId: context.userId, isAdmin: true,
  }));
  if (!selected.success || selected.data.dispute.dispute_id !== target.data.dispute_id) {
    throw new AppError('Dispute resolution information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selected.data);
  return selected.data;
}
async function selectDisputeResolution({ context, disputeId }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  const selected = await readSelection({ context, disputeId });
  return Object.freeze({ ...selected, entry: Object.freeze(selected.entry), dispute: Object.freeze(selected.dispute) });
}
function parseResolution(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== resolveDisputeDefinition.name) throw new ValidationError('Invalid dispute resolution proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = resolveDisputeContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, disputeId: expected.dispute.dispute_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Dispute eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed dispute, contribution or context changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const maxTimestamp = '9999-12-31T23:59:59.999999999Z';
  const maxResolvedAt = '9999-12-31T23:59:59.999999999+00:00';
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    conversationId: proposal.id, secondaryConfirmation: { token: proposal.id, confirmedAt: maxTimestamp },
    auditIds: Object.fromEntries(['proposed', 'approved', 'confirmed', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, dispute: { ...proposal.after.dispute, resolved_at: maxResolvedAt } },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Dispute details are too large for an approval card. Please shorten the resolution note.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = resolveDisputeContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !resolveDisputeArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected open dispute and valid resolution note are required');
  }
  assertSelection(context, selected.data);
  const parameters = resolveDisputeParametersFromArgs(selected.data, args);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({ id, tool, tier: 4, summary: DISPUTE_RESOLVE_SUMMARY, parameters,
    before: selected.data, after: resolveDisputeAfter(selected.data, parameters),
    secondary_confirmation: SECONDARY_CONFIRMATION, expires_at: expiresAt });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  await revalidateSelection({ context, selection: parseResolution(proposal).before });
}
async function applyProposal({ context, proposal, actorCtx, trace }) {
  assertAgentContext(context, 'admin');
  const parsed = parseResolution(proposal);
  assertSelection(context, parsed.before);
  const origin = disputeExecutionTraceSchema.safeParse(trace);
  if (!origin.success) throw new ValidationError('A server-owned dispute execution trace is required');
  const disputes = require('../../services/dispute.service');
  const rows = await disputes.resolveDispute({ workspaceId: context.workspace.id,
    disputeId: parsed.parameters.dispute_id, resolutionNote: parsed.parameters.resolution_note,
    resolvedByMemberId: context.member.id, isAdmin: true,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
    reviewedResolution: { userId: context.userId, isAdmin: true, proposalId: parsed.id,
      trace: origin.data, expected: parsed.before },
  });
  const result = resolveDisputeResultSchema.safeParse({ dispute: disputeResolutionState(rows?.dispute), entry: disputeEntryState(rows?.entry) });
  if (!result.success || !resolveDisputeResultMatches(parsed, result.data)) {
    throw new AppError('The dispute resolution result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal) => ({ targetType: 'dispute', targetId: proposal.parameters.dispute_id });
const getStatusTarget = (proposal) => ({ dispute_id: proposal.parameters.dispute_id,
  container_id: proposal.parameters.container_id, entry_id: proposal.parameters.entry_id });

module.exports = { definitions, resolveDisputeDefinition, getDefinition, selectDisputeResolution,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget };
