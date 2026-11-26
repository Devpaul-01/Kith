const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { noteContextMatches } = require('../../validators/dispute-note.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, disputeNoteTargetSchema, disputeNoteContextSchema, disputeNoteArgumentsSchema,
  disputeNoteResultSchema, disputeNoteParametersFromArgs, disputeNoteAfter, disputeNoteResultMatches,
  DISPUTE_NOTE_SUMMARY, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const addDisputeNoteDefinition = Object.freeze({
  name: 'add_dispute_note', tier: 2, minRole: 'member',
  description: 'Propose adding one note to the exact open dispute explicitly selected for this message. Supply only the requested note, trimmed to 1–1000 characters; clarify a missing or ambiguous note. The authenticated user must be an admin or the member who raised the dispute. The approval card binds the dispute identity, the exact note text and the authenticated author; the author and time are recorded by the server. Existing notes are not part of the approval and are never changed, so concurrent notes are preserved. Resolved disputes, notes by anyone else, edits and deletions are unavailable. The tool creates an approval card only; it never adds the note until the separate approval endpoint is used. Other selections, history, search candidates and IDs in prose cannot choose a target.',
  parameterSchema: disputeNoteArgumentsSchema,
});
const definitions = Object.freeze([addDisputeNoteDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context);
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role || !noteContextMatches(selection)) {
    throw new ForbiddenError('Dispute notes must use the authenticated member and reviewed dispute');
  }
}
async function readSelection({ context, disputeId }) {
  assertAgentContext(context);
  const target = disputeNoteTargetSchema.safeParse({ dispute_id: disputeId });
  if (!target.success) throw new ValidationError('Invalid dispute note selection');
  const disputes = require('../../services/dispute.service');
  const selected = disputeNoteContextSchema.safeParse(await disputes.getDisputeNoteContext({
    workspaceId: context.workspace.id, disputeId: target.data.dispute_id,
    callerId: context.member.id, userId: context.userId,
  }));
  if (!selected.success || selected.data.dispute.dispute_id !== target.data.dispute_id) {
    throw new AppError('Dispute note information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selected.data);
  return selected.data;
}
async function selectDisputeNote({ context, disputeId }) {
  assertAgentContext(context);
  await assertCurrentActor(context);
  const selected = await readSelection({ context, disputeId });
  return Object.freeze({ ...selected, dispute: Object.freeze(selected.dispute) });
}
function parseNote(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== addDisputeNoteDefinition.name) throw new ValidationError('Invalid dispute note proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context);
  const expected = disputeNoteContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, disputeId: expected.dispute.dispute_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Dispute eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed dispute or context changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { dispute_id: proposal.after.dispute_id,
      note: { ...proposal.after.note, added_at: '9999-12-31T23:59:59.999Z' } },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('The note is too large for an approval card. Please shorten it.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context);
  const selected = disputeNoteContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !disputeNoteArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected open dispute and a valid note are required');
  }
  assertSelection(context, selected.data);
  const parameters = disputeNoteParametersFromArgs(selected.data, args);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({ id, tool, tier: 2, summary: DISPUTE_NOTE_SUMMARY, parameters,
    before: selected.data, after: disputeNoteAfter(selected.data, parameters), expires_at: expiresAt });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context);
  await revalidateSelection({ context, selection: parseNote(proposal).before });
}
async function applyProposal({ context, proposal }) {
  assertAgentContext(context);
  const parsed = parseNote(proposal);
  assertSelection(context, parsed.before);
  const disputes = require('../../services/dispute.service');
  const result = disputeNoteResultSchema.safeParse(await disputes.addReviewedDisputeNote({
    workspaceId: context.workspace.id, disputeId: parsed.parameters.dispute_id,
    note: parsed.parameters.note, authorMemberId: context.member.id,
  }));
  if (!result.success || !disputeNoteResultMatches(parsed, result.data)) {
    throw new AppError('The dispute note result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal) => ({ targetType: 'dispute', targetId: proposal.parameters.dispute_id });
const getStatusTarget = (proposal) => ({ dispute_id: proposal.parameters.dispute_id });

module.exports = { definitions, addDisputeNoteDefinition, getDefinition, selectDisputeNote,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget };
