const { AppError, BusinessRuleError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  taskTargetSchema, taskSnapshotSchema, taskProgressSnapshotSchema,
  taskProgressParametersSchema, taskProgressResultSchema, taskProposalSummary, proposalSchema,
} = require('../validators/proposal.validator');

const updateTaskDefinition = Object.freeze({
  name: 'update_task', tier: 2, minRole: 'member',
  description: 'Propose setting your explicitly selected task to in_progress or completed, optionally changing its completion_note. Only your own active, unconfirmed assignments are supported, including for admins. The target is supplied by the current user selection, never by model arguments or chat text. Completed/cancelled tasks, reassignment, admin confirmation, proof changes and reopening are unavailable. This creates an approval card; only the separate approval endpoint updates the task.',
  parameterSchema: taskProgressParametersSchema,
});
const definitions = Object.freeze([updateTaskDefinition]);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

function assertOwnedSnapshot(context, snapshot) {
  assertAgentContext(context);
  if (snapshot.assigned_to !== context.member.id) {
    throw new ForbiddenError('You can only change progress on your own assigned tasks');
  }
}

async function readSnapshot({ context, containerId, taskId }) {
  assertAgentContext(context);
  const target = taskTargetSchema.safeParse({ container_id: containerId, task_id: taskId });
  if (!target.success) throw new ValidationError('Invalid task selection');
  const tasks = require('../../services/task.service');
  const raw = await tasks.getTask({
    workspaceId: context.workspace.id, containerId: target.data.container_id,
    taskId: target.data.task_id, isAdmin: context.member.role === 'admin', callerId: context.member.id,
  });
  assertOwnedSnapshot(context, raw || {});
  const selected = taskSnapshotSchema.safeParse(Object.fromEntries(
    Object.keys(taskSnapshotSchema.shape).map((field) => [field, raw[field]]),
  ));
  if (!selected.success || selected.data.id !== target.data.task_id
      || selected.data.container_id !== target.data.container_id || raw.deleted_at != null) {
    throw new AppError('Task information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  return selected.data;
}

async function selectTask({ context, containerId, taskId }) {
  await assertCurrentActor(context);
  const snapshot = await readSnapshot({ context, containerId, taskId });
  if (!taskProgressSnapshotSchema.safeParse(snapshot).success) {
    throw new BusinessRuleError('Only active tasks without admin confirmation support self progress updates');
  }
  return Object.freeze(snapshot);
}

function parseTaskProposal(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== updateTaskDefinition.name) throw new ValidationError('Invalid task proposal');
  return parsed;
}

async function revalidateOne({ context, snapshot }) {
  const expected = taskProgressSnapshotSchema.parse(snapshot);
  assertOwnedSnapshot(context, expected);
  let current;
  try {
    current = await readSnapshot({ context, containerId: expected.container_id, taskId: expected.id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN'].includes(err.code)) throw err;
    throw new AppError('The selected task is no longer available to you. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The task changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  const definition = getDefinition(tool);
  const selected = taskProgressSnapshotSchema.safeParse(selection);
  const changes = taskProgressParametersSchema.safeParse(args);
  if (!definition || !selected.success || !changes.success) {
    throw new ValidationError('An explicitly selected task and valid progress arguments are required');
  }
  await assertCurrentActor(context);
  await revalidateOne({ context, snapshot: selected.data });
  const after = {
    status: changes.data.status,
    completion_note: changes.data.completion_note === undefined
      ? selected.data.completion_note : changes.data.completion_note,
  };
  if (after.status === selected.data.status && after.completion_note === selected.data.completion_note) {
    throw new BusinessRuleError('The selected task already has the requested progress');
  }
  return proposalSchema.parse({
    id, tool, tier: 2, summary: taskProposalSummary(changes.data),
    parameters: { container_id: selected.data.container_id, task_id: selected.data.id, ...changes.data },
    before: selected.data, after, expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  const parsed = parseTaskProposal(proposal);
  await revalidateOne({ context, snapshot: parsed.before });
}

async function applyProposal({ context, proposal, actorCtx }) {
  const parsed = parseTaskProposal(proposal);
  assertOwnedSnapshot(context, parsed.before);
  const { task_id: taskId, container_id: containerId, ...data } = parsed.parameters;
  const tasks = require('../../services/task.service');
  const raw = await tasks.updateTask({
    workspaceId: context.workspace.id, containerId, taskId, data,
    isAdmin: context.member.role === 'admin', callerId: context.member.id,
    actorDisplayName: context.member.displayName,
    actorCtx: {
      workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    },
    expectedTask: parsed.before,
  });
  const result = taskProgressResultSchema.safeParse({
    task_id: raw?.id, container_id: raw?.container_id, status: raw?.status,
    completion_note: raw?.completion_note, completed_at: raw?.completed_at, updated_at: raw?.updated_at,
  });
  if (!result.success || result.data.task_id !== taskId || result.data.container_id !== containerId
      || raw.assigned_to !== context.member.id || raw.admin_confirmed_at !== null
      || result.data.status !== parsed.after.status || result.data.completion_note !== parsed.after.completion_note
      || (result.data.status === 'completed' && raw.completed_by !== context.member.id)
      || (result.data.status === 'in_progress' && result.data.completed_at !== parsed.before.completed_at)) {
    throw new AppError('The task update result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return { targetType: 'task', targetId: proposal.parameters.task_id };
}

function getStatusTarget(proposal) {
  return { task_id: proposal.parameters.task_id, container_id: proposal.parameters.container_id };
}

module.exports = {
  definitions, updateTaskDefinition, getDefinition, selectTask,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
