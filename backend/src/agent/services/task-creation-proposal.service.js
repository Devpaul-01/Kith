const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { taskCreationState } = require('../../validators/task-creation.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, taskCreationTargetSchema, taskCreationContextSchema, taskCreationArgumentsSchema,
  taskCreationResultSchema, taskCreationParametersFromArgs, taskCreationAfter, taskCreationResultMatches,
  TASK_CREATION_SUMMARY, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const createTaskDefinition = Object.freeze({
  name: 'create_task', tier: 3, minRole: 'admin',
  description: 'Propose one new task in the active task-enabled event or recurring container explicitly selected for this message. Supply the requested title and only requested description and explicit valid YYYY-MM-DD due_date. The current selection fixes the assignee to one active non-proxy participant with task tracking enabled, or leaves the task unassigned. A member without a linked login is supported. Clarify ambiguous titles, relative dates and requests to assign a member who is not currently selected. IDs, status, creator, sorting, proofs, completion/admin fields, proxies and bulk creation are unavailable. The full card shows the reviewed container and assignee and complete pending task state. Only separate approval creates the task; text, historical selections, receipts and search candidates cannot select or approve it.',
  parameterSchema: taskCreationArgumentsSchema,
});
const definitions = Object.freeze([createTaskDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can create this task');
  }
}
async function readSelection({ context, containerId, assigneeId = null }) {
  assertAgentContext(context, 'admin');
  const target = taskCreationTargetSchema.safeParse({ container_id: containerId, assignee_id: assigneeId });
  if (!target.success) throw new ValidationError('Invalid task creation selection');
  const tasks = require('../../services/task.service');
  const selected = taskCreationContextSchema.safeParse(await tasks.getTaskCreationContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id, assigneeId: target.data.assignee_id,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!selected.success || selected.data.container_id !== target.data.container_id
      || (selected.data.assignee?.member_id ?? null) !== target.data.assignee_id) {
    throw new AppError('Task creation information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selected.data);
  return selected.data;
}
async function selectTaskCreation({ context, containerId, assigneeId = null }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  const selected = await readSelection({ context, containerId, assigneeId });
  return Object.freeze({ ...selected, assignee: selected.assignee ? Object.freeze(selected.assignee) : null });
}
function parseCreation(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== createTaskDefinition.name) throw new ValidationError('Invalid task creation proposal');
  return parsed;
}
async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = taskCreationContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id,
      assigneeId: expected.assignee?.member_id ?? null });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Task creation eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed task container or assignee changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}
function assertRecordFits(proposal) {
  const maxTimestamp = '9999-12-31T23:59:59.999999999+00:00';
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, created_at: maxTimestamp, updated_at: maxTimestamp },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('Task details are too large for an approval card. Please shorten the text.');
  }
}
async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = taskCreationContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !taskCreationArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected task container and valid task details are required');
  }
  assertSelection(context, selected.data);
  const parameters = taskCreationParametersFromArgs(selected.data, args);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({ id, tool, tier: 3, summary: TASK_CREATION_SUMMARY, parameters,
    before: selected.data, after: taskCreationAfter(selected.data, parameters, id), expires_at: expiresAt });
  assertRecordFits(proposal);
  return proposal;
}
async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  await revalidateSelection({ context, selection: parseCreation(proposal).before });
}
async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseCreation(proposal);
  assertSelection(context, parsed.before);
  const { container_id: containerId, ...data } = parsed.parameters;
  const tasks = require('../../services/task.service');
  const row = await tasks.createTask({ workspaceId: context.workspace.id, containerId, data,
    actorMemberId: context.member.id, actorDisplayName: context.member.displayName,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
    reviewedCreation: { userId: context.userId, isAdmin: context.member.role === 'admin',
      taskId: parsed.id, expected: parsed.before },
  });
  const result = taskCreationResultSchema.safeParse(taskCreationState(row));
  if (!result.success || !taskCreationResultMatches(parsed, result.data)) {
    throw new AppError('The task creation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}
const getAuditTarget = (proposal) => ({ targetType: 'task', targetId: proposal.id });
const getStatusTarget = (proposal) => ({ task_id: proposal.id,
  container_id: proposal.parameters.container_id, assigned_to: proposal.parameters.assigned_to });

module.exports = { definitions, createTaskDefinition, getDefinition, selectTaskCreation,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget };
