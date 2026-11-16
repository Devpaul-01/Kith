const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { disputeEntryState, raisedDisputeState, disputeExecutionTraceSchema } = require('../../validators/dispute-raise.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, raiseDisputeTargetSchema, raiseDisputeContextSchema, raiseDisputeArgumentsSchema,
  raiseDisputeResultSchema, raiseDisputeParametersFromArgs, raiseDisputeAfter, raiseDisputeResultMatches,
  DISPUTE_RAISE_SUMMARY, SECONDARY_CONFIRMATION, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const raiseDisputeDefinition = Object.freeze({
  name: 'raise_dispute', tier: 4, minRole: 'member',
  description: 'Propose opening one dispute on the exact confirmed contribution explicitly selected for this message and owned by the authenticated caller, including admins acting for themselves. Supply only the requested reason, trimmed to 5–1000 characters. The active event must have money tracking enabled and the positive non-crypto contribution must use the workspace base currency with no recurring cycle or correction link. Existing proofs do not prevent raising a dispute; proof metadata is outside this approval and never inspected or uploaded. The full Tier 4 card binds the reviewed immutable financial fields and requested reason to an open dispute and disputed entry status. Postgres assigns the new dispute ID and time on execution. Separate approval must be followed by a distinct authenticated typed confirm request; chat text never approves or confirms. IDs, other selections, prior cards, receipts, search candidates, pending entries, proxies, on-behalf actions and resolution are unavailable.',
  parameterSchema: raiseDisputeArgumentsSchema,
});
const definitions = Object.freeze([raiseDisputeDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context);
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role || selection.entry.workspace_id !== context.workspace.id
      || selection.entry.container_id !== selection.container_id || selection.entry.contributor_id !== context.member.id) {
    throw new ForbiddenError('Only the contribution owner can create this dispute');
  }
  if (selection.entry.original_currency !== selection.base_currency
      || selection.entry.original_amount !== selection.entry.base_amount) {
    throw new ValidationError('Disputes must use the reviewed base-currency contribution');
  }
}
async function readSelection({ context, containerId, entryId }) {
  assertAgentContext(context);
  const target = raiseDisputeTargetSchema.safeParse({ container_id: containerId, entry_id: entryId });
  if (!target.success) throw new ValidationError('Invalid dispute contribution selection');
  const disputes = require('../../services/dispute.service');
  const selected = raiseDisputeContextSchema.safeParse(await disputes.getRaiseDisputeContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id, entryId: target.data.entry_id,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!selected.success || selected.data.container_id !== target.data.container_id
      || selected.data.entry.entry_id !== target.data.entry_id) {
    throw new AppError('Dispute contribution information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selected.data);
  return selected.data;
}
async function selectDisputeContribution({ context, containerId, entryId }) {
  assertAgentContext(context);
  await assertCurrentActor(context);
  const selected = await readSelection({ context, containerId, entryId });
  return Object.freeze({ ...selected, entry: Object.freeze(selected.entry) });
}
function parseDispute(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== raiseDisputeDefinition.name) throw new ValidationError('Invalid dispute creation proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context);
  const expected = raiseDisputeContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id, entryId: expected.entry.entry_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Dispute eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed contribution or dispute context changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const maxTimestamp = '9999-12-31T23:59:59.999999999Z';
  const maxRaisedAt = '9999-12-31T23:59:59.999999999+00:00';
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    conversationId: proposal.id, secondaryConfirmation: { token: proposal.id, confirmedAt: maxTimestamp },
    auditIds: Object.fromEntries(['proposed', 'approved', 'confirmed', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, dispute: { ...proposal.after.dispute, dispute_id: proposal.id, raised_at: maxRaisedAt } },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Dispute details are too large for an approval card. Please shorten the reason.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context);
  const selected = raiseDisputeContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !raiseDisputeArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected confirmed contribution and valid reason are required');
  }
  assertSelection(context, selected.data);
  const parameters = raiseDisputeParametersFromArgs(selected.data, args);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({ id, tool, tier: 4, summary: DISPUTE_RAISE_SUMMARY, parameters,
    before: selected.data, after: raiseDisputeAfter(selected.data, parameters),
    secondary_confirmation: SECONDARY_CONFIRMATION, expires_at: expiresAt });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context);
  await revalidateSelection({ context, selection: parseDispute(proposal).before });
}
async function applyProposal({ context, proposal, actorCtx, trace }) {
  assertAgentContext(context);
  const parsed = parseDispute(proposal);
  assertSelection(context, parsed.before);
  const origin = disputeExecutionTraceSchema.safeParse(trace);
  if (!origin.success) throw new ValidationError('A server-owned dispute execution trace is required');
  const disputes = require('../../services/dispute.service');
  const rows = await disputes.raiseDispute({ workspaceId: context.workspace.id,
    containerId: parsed.parameters.container_id, entryId: parsed.parameters.entry_id, reason: parsed.parameters.reason,
    callerId: context.member.id, isAdmin: context.member.role === 'admin', actorDisplayName: context.member.displayName,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
    reviewedRaise: { userId: context.userId, isAdmin: context.member.role === 'admin',
      proposalId: parsed.id, trace: origin.data, expected: parsed.before },
  });
  const result = raiseDisputeResultSchema.safeParse({ dispute: raisedDisputeState(rows?.dispute), entry: disputeEntryState(rows?.entry) });
  if (!result.success || !raiseDisputeResultMatches(parsed, result.data)) {
    throw new AppError('The dispute creation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal, context, result) => result
  ? { targetType: 'dispute', targetId: result.dispute.dispute_id }
  : { targetType: 'ledger_entry', targetId: proposal.parameters.entry_id };
const getStatusTarget = (proposal) => ({ container_id: proposal.parameters.container_id, entry_id: proposal.parameters.entry_id });

module.exports = { definitions, raiseDisputeDefinition, getDefinition, selectDisputeContribution,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget };
