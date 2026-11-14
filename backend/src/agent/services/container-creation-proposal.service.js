const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { eventContainerCreationDataSchema } = require('../../validators/workspace.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, containerCreationContextSchema, containerCreationArgumentsSchema,
  containerCreationAfterSchema, containerCreationResultSchema,
  containerCreationParametersFromArgs, containerCreationAfter, containerCreationResultMatches,
  CONTAINER_CREATION_SUMMARY, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const createContainerDefinition = Object.freeze({
  name: 'create_container', tier: 3, minRole: 'admin',
  description: 'Propose creating a new event container in the current workspace when the user explicitly requests it. Provide the requested name and only requested subtitle, description, event_date, event_type, event_type_category, enable_money or enable_tasks fields. Dates must be explicit calendar dates in YYYY-MM-DD; clarify relative or ambiguous dates. Omitted tracking flags are false, optional text/date fields are null, and category is other. Workspace, creator, container ID, active status, defaults and execution timestamps are server-controlled. Budgets, recurring schedules, participants, files and public links are unavailable. Creating a container needs no existing entity selection. This emits a full before/after approval card; only the separate approval endpoint creates the container.',
  parameterSchema: containerCreationArgumentsSchema,
});
const definitions = Object.freeze([createContainerDefinition]);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

function assertCreationContext(context, current) {
  assertAgentContext(context, 'admin');
  if (current.workspace_id !== context.workspace.id
      || current.actor_member_id !== context.member.id || current.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can create this container');
  }
}

async function readCreationContext(context) {
  assertAgentContext(context, 'admin');
  const containers = require('../../services/container.service');
  const parsed = containerCreationContextSchema.safeParse(await containers.getContainerCreationContext({
    workspaceId: context.workspace.id, callerId: context.member.id,
    userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!parsed.success) {
    throw new AppError('Container creation information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertCreationContext(context, parsed.data);
  return parsed.data;
}

async function selectContainerCreationContext({ context }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  return Object.freeze(await readCreationContext(context));
}

function parseCreation(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== createContainerDefinition.name) throw new ValidationError('Invalid container creation proposal');
  return parsed;
}

function reviewedContext(proposal) {
  const { container, ...current } = proposal.before;
  return containerCreationContextSchema.parse(current);
}

function assertCreationRecordFits(proposal) {
  // Project the largest permitted completed record before issuing a card.
  // These fixed-length bookkeeping IDs/timestamps are never saved or exposed.
  const maxTimestamp = '9999-12-31T23:59:59.999999999+00:00';
  const result = containerCreationResultSchema.parse({
    ...proposal.after, created_at: maxTimestamp, updated_at: maxTimestamp,
  });
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])), result,
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Container details are too large for an approval card. Please shorten the text.');
  }
}

async function createProposalDraft({ context, tool, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  if (!getDefinition(tool) || !containerCreationArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('Valid event container creation arguments are required');
  }
  const parameters = containerCreationParametersFromArgs(args);
  await assertCurrentActor(context);
  const current = await readCreationContext(context);
  const proposal = proposalSchema.parse({
    id, tool, tier: 3, summary: CONTAINER_CREATION_SUMMARY, parameters,
    before: { ...current, container: null }, after: containerCreationAfter(current, parameters, id),
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
    throw new AppError('Container creation eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
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
  const containers = require('../../services/container.service');
  const row = await containers.createContainer({
    workspaceId: context.workspace.id, data: eventContainerCreationDataSchema.parse(parsed.parameters),
    actorMemberId: context.member.id,
    actorCtx: {
      workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    },
    reviewedCreation: { userId: context.userId, isAdmin: context.member.role === 'admin',
      expected, containerId: parsed.id },
  });
  const result = containerCreationResultSchema.safeParse(Object.fromEntries(
    Object.keys(containerCreationAfterSchema.shape)
      .map((field) => [field, field === 'container_id' ? row?.id : row?.[field]]),
  ));
  if (!result.success || !containerCreationResultMatches(parsed, result.data)) {
    throw new AppError('The container creation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return { targetType: 'container', targetId: proposal.id };
}

function getStatusTarget(proposal) {
  return { container_id: proposal.id };
}

module.exports = {
  definitions, createContainerDefinition, getDefinition, selectContainerCreationContext,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
