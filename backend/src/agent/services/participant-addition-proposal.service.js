const { AppError, BusinessRuleError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { participantAdditionState } = require('../../validators/participant-addition.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, participantAdditionTargetSchema, participantAdditionContextSchema,
  participantAdditionArgumentsSchema, participantAdditionRowSchema, participantAdditionParametersFromArgs,
  participantAdditionAfter, participantAdditionResultMatches, PARTICIPANT_ADDITION_SUMMARY,
  proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const addParticipantsDefinition = Object.freeze({
  name: 'add_participants', tier: 3, minRole: 'admin',
  description: 'Propose adding the one non-proxy workspace member and event container explicitly selected for this message. Supply only explicitly requested money_enabled and tasks_enabled flags; both default to false and require the corresponding container feature to be enabled. The full card shows the member, event and complete new participation state. IDs, participant arrays, targets, notes, custom roles, proxy actions, groups and recurring pools are unavailable. This requests approval; only the separate approval endpoint adds the member. Existing participants are never modified.',
  parameterSchema: participantAdditionArgumentsSchema,
});
const definitions = Object.freeze([addParticipantsDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can add this participant');
  }
}
async function readSelection({ context, containerId, memberId }) {
  assertAgentContext(context, 'admin');
  const target = participantAdditionTargetSchema.safeParse({ container_id: containerId, member_id: memberId });
  if (!target.success) throw new ValidationError('Invalid participant addition selection');
  const participants = require('../../services/participant.service');
  const selection = participantAdditionContextSchema.safeParse(await participants.getParticipantAdditionContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id, memberId: target.data.member_id,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!selection.success || selection.data.container_id !== target.data.container_id
      || selection.data.workspace_member_id !== target.data.member_id) {
    throw new AppError('Participant addition information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selection.data);
  return selection.data;
}
async function selectParticipantAddition({ context, containerId, memberId }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  return Object.freeze(await readSelection({ context, containerId, memberId }));
}
function parseAddition(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== addParticipantsDefinition.name) throw new ValidationError('Invalid participant addition proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = participantAdditionContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id, memberId: expected.workspace_member_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Participant addition eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed member or event changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, added_at: '9999-12-31T23:59:59.999999999+00:00' },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Participant details are too large for an approval card.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = participantAdditionContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !participantAdditionArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected member/event and valid tracking flags are required');
  }
  assertSelection(context, selected.data);
  const parameters = participantAdditionParametersFromArgs(selected.data, args);
  if ((parameters.money_enabled && !selected.data.enable_money) || (parameters.tasks_enabled && !selected.data.enable_tasks)) {
    throw new BusinessRuleError('Participant tracking must be enabled in the selected event');
  }
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({
    id, tool, tier: 3, summary: PARTICIPANT_ADDITION_SUMMARY, parameters,
    before: selected.data, after: participantAdditionAfter(selected.data, parameters, id), expires_at: expiresAt,
  });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  await revalidateSelection({ context, selection: parseAddition(proposal).before });
}
async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseAddition(proposal);
  assertSelection(context, parsed.before);
  const { container_id: containerId, ...data } = parsed.parameters;
  const participants = require('../../services/participant.service');
  const response = await participants.addParticipants({
    workspaceId: context.workspace.id, containerId, participants: [data], actorMemberId: context.member.id,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
    reviewedAddition: { userId: context.userId, isAdmin: context.member.role === 'admin', participantId: parsed.id,
      expected: parsed.before },
  });
  const result = participantAdditionRowSchema.safeParse(participantAdditionState(response?.added?.[0]));
  if (!Array.isArray(response?.added) || response.added.length !== 1
      || response.skipped_already_present !== 0 || response.skipped_invalid_member !== 0
      || !result.success || !participantAdditionResultMatches(parsed, result.data)) {
    throw new AppError('The participant addition result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal) => ({ targetType: 'container', targetId: proposal.parameters.container_id });
const getStatusTarget = (proposal) => ({ participant_id: proposal.id,
  container_id: proposal.parameters.container_id, workspace_member_id: proposal.parameters.workspace_member_id });

module.exports = {
  definitions, addParticipantsDefinition, getDefinition, selectParticipantAddition,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
