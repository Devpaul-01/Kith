const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, containerArchiveTargetSchema, containerArchiveContextSchema, containerArchiveArgumentsSchema,
  containerArchiveResultSchema, containerArchiveAfter, containerArchiveResultMatches, CONTAINER_ARCHIVE_SUMMARY,
  proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const archiveContainerDefinition = Object.freeze({
  name: 'archive_container', tier: 3, minRole: 'admin',
  description: 'Propose archiving the active or completed container explicitly selected for this message. Use no arguments and only act on the user request. The approval card shows the container name, type and current status and binds the exact reviewed version; if it changes before execution the proposal becomes stale. Deleted, already archived or cancelled containers, renaming, completing, deleting and any other settings are unavailable. The tool creates an approval card only; it never archives anything until the separate approval endpoint is used. Other selections, history, search candidates and IDs in prose cannot choose a target.',
  parameterSchema: containerArchiveArgumentsSchema,
});
const definitions = Object.freeze([archiveContainerDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can archive this container');
  }
}
async function readSelection({ context, containerId }) {
  assertAgentContext(context, 'admin');
  const target = containerArchiveTargetSchema.safeParse({ container_id: containerId });
  if (!target.success) throw new ValidationError('Invalid container archive selection');
  const containers = require('../../services/container.service');
  const selected = containerArchiveContextSchema.safeParse(await containers.getContainerArchiveContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id,
    callerId: context.member.id, userId: context.userId,
  }));
  if (!selected.success || selected.data.container.container_id !== target.data.container_id) {
    throw new AppError('Container archive information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selected.data);
  return selected.data;
}
async function selectContainerArchive({ context, containerId }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  const selected = await readSelection({ context, containerId });
  return Object.freeze({ ...selected, container: Object.freeze(selected.container) });
}
function parseArchive(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== archiveContainerDefinition.name) throw new ValidationError('Invalid container archive proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = containerArchiveContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container.container_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Container eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The container changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, updated_at: '9999-12-31T23:59:59.999999999+00:00' },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('This container has too much text for an approval card.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = containerArchiveContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !containerArchiveArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected active or completed container and empty arguments are required');
  }
  assertSelection(context, selected.data);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({ id, tool, tier: 3, summary: CONTAINER_ARCHIVE_SUMMARY,
    parameters: { container_id: selected.data.container.container_id }, before: selected.data,
    after: containerArchiveAfter(selected.data), expires_at: expiresAt });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  await revalidateSelection({ context, selection: parseArchive(proposal).before });
}
async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseArchive(proposal);
  assertSelection(context, parsed.before);
  const containers = require('../../services/container.service');
  const result = containerArchiveResultSchema.safeParse(await containers.archiveReviewedContainer({
    workspaceId: context.workspace.id, containerId: parsed.parameters.container_id, expected: parsed.before,
    proposalId: parsed.id,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
  }));
  if (!result.success || !containerArchiveResultMatches(parsed, result.data)) {
    throw new AppError('The container archive result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal) => ({ targetType: 'container', targetId: proposal.parameters.container_id });
const getStatusTarget = (proposal) => ({ container_id: proposal.parameters.container_id });

module.exports = { definitions, archiveContainerDefinition, getDefinition, selectContainerArchive,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget };
