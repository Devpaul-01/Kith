const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { memberCreationDataSchema } = require('../../validators/member-creation.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, memberCreationContextSchema, memberCreationArgumentsSchema,
  memberCreationAfterSchema, memberCreationResultSchema,
  memberCreationParametersFromArgs, memberCreationAfter, memberCreationResultMatches,
  MEMBER_CREATION_SUMMARY, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const createMemberDefinition = Object.freeze({
  name: 'create_member', tier: 3, minRole: 'admin',
  description: 'Propose creating a new member in the current workspace when the user explicitly requests a new member record. Provide display_name and only requested is_proxy, relationship_to_head, relationship_category, date_of_birth and admin_notes. Only set is_proxy when the user explicitly requests a proxy; proxies are managed by the requesting admin. Another proxy manager is unavailable. Omitted is_proxy is false, category is other and optional text/date fields are null. A birth date must be an explicit valid YYYY-MM-DD calendar date; never infer it from an age or a relative date. Clarify unclear creation, names or proxy intent. Workspace, new ID, member role, manager, active state and timestamps are server-controlled. This creates a member record without a linked user account, invitation, participants or uploaded files. It never creates an admin or updates an existing member, even when names match. No existing entity selection is required. This emits a full before/after approval card; only the separate approval endpoint creates the member.',
  parameterSchema: memberCreationArgumentsSchema,
});
const definitions = Object.freeze([createMemberDefinition]);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

function assertCreationContext(context, current) {
  assertAgentContext(context, 'admin');
  if (current.workspace_id !== context.workspace.id
      || current.actor_member_id !== context.member.id || current.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can create this member');
  }
}

async function readCreationContext(context) {
  assertAgentContext(context, 'admin');
  const members = require('../../services/member.service');
  const parsed = memberCreationContextSchema.safeParse(await members.getMemberCreationContext({
    workspaceId: context.workspace.id, callerId: context.member.id,
    userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!parsed.success) {
    throw new AppError('Member creation information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertCreationContext(context, parsed.data);
  return parsed.data;
}

function parseCreation(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== createMemberDefinition.name) throw new ValidationError('Invalid member creation proposal');
  return parsed;
}

function reviewedContext(proposal) {
  const { member, ...current } = proposal.before;
  return memberCreationContextSchema.parse(current);
}

function assertCreationRecordFits(proposal) {
  // Check the largest permitted saved receipt before issuing a card. These
  // placeholder bookkeeping values are never saved or sent to the caller.
  const maxTimestamp = '9999-12-31T23:59:59.999999999+00:00';
  const result = memberCreationResultSchema.parse({
    ...proposal.after, joined_at: maxTimestamp, created_at: maxTimestamp, updated_at: maxTimestamp,
  });
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])), result,
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Member details are too large for an approval card. Please shorten the text.');
  }
}

async function createProposalDraft({ context, tool, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  if (!getDefinition(tool) || !memberCreationArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('Valid member creation arguments are required');
  }
  const parameters = memberCreationParametersFromArgs(args);
  await assertCurrentActor(context);
  const current = await readCreationContext(context);
  const proposal = proposalSchema.parse({
    id, tool, tier: 3, summary: MEMBER_CREATION_SUMMARY, parameters,
    before: { ...current, member: null }, after: memberCreationAfter(current, parameters, id),
    expires_at: expiresAt,
  });
  assertCreationRecordFits(proposal);
  return proposal;
}

async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  const expected = reviewedContext(parseCreation(proposal));
  assertCreationContext(context, expected);
  let current;
  try {
    current = await readCreationContext(context);
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Member creation eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed workspace changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseCreation(proposal);
  const expected = reviewedContext(parsed);
  assertCreationContext(context, expected);
  const members = require('../../services/member.service');
  const row = await members.createMember({
    workspaceId: context.workspace.id, data: memberCreationDataSchema.parse(parsed.parameters),
    actorCtx: {
      workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    },
    reviewedCreation: { userId: context.userId, isAdmin: context.member.role === 'admin',
      expected, memberId: parsed.id },
  });
  const result = memberCreationResultSchema.safeParse(Object.fromEntries(
    Object.keys(memberCreationAfterSchema.shape)
      .map((field) => [field, field === 'member_id' ? row?.id : row?.[field]]),
  ));
  if (!result.success || !memberCreationResultMatches(parsed, result.data)) {
    throw new AppError('The member creation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return { targetType: 'workspace_member', targetId: proposal.id };
}

function getStatusTarget(proposal) {
  return { member_id: proposal.id };
}

module.exports = {
  definitions, createMemberDefinition, getDefinition,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
