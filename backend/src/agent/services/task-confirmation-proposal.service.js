const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { taskConfirmationState } = require('../../validators/task-confirmation.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS, taskTargetSchema, taskConfirmationContextSchema, taskConfirmationArgumentsSchema,
  taskConfirmationResultSchema, taskConfirmationAfter, taskConfirmationResultMatches,
  TASK_CONFIRMATION_SUMMARY, proposalSchema, proposalRecordSchema,
} = require('../validators/proposal.validator');

const adminConfirmTaskDefinition = Object.freeze({
  name: 'admin_confirm_task', tier: 3, minRole: 'admin',
  description: 'Propose admin confirmation of the completed task explicitly selected for this message. Use no arguments and only act on the user request. The full approval card preserves the task, assignment, completion details, notes and exact uploaded proof metadata, and sets the authenticated confirmer and confirmation time on approval. Proof attachments are for admin review; never claim to have inspected their contents. Only unconfirmed completed tasks in active containers with task tracking enabled are supported. IDs in text, search results or earlier turns are not selections. This requests a card; only the separate approval endpoint confirms the task.',
  parameterSchema: taskConfirmationArgumentsSchema,
});
const definitions = Object.freeze([adminConfirmTaskDefinition]);
const getDefinition = (name) => definitions.find((definition) => definition.name === name);

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id || selection.actor_member_id !== context.member.id
      || selection.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can confirm this task');
  }
}

async function readSelection({ context, containerId, taskId }) {
  assertAgentContext(context, 'admin');
  const target = taskTargetSchema.safeParse({ container_id: containerId, task_id: taskId });
  if (!target.success) throw new ValidationError('Invalid task confirmation selection');
  const tasks = require('../../services/task.service');
  const selection = taskConfirmationContextSchema.safeParse(await tasks.getTaskConfirmationContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id, taskId: target.data.task_id,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  }));
  if (!selection.success || selection.data.container_id !== target.data.container_id
      || selection.data.task_id !== target.data.task_id) {
    throw new AppError('Task confirmation information is unavailable.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelection(context, selection.data);
  return selection.data;
}

async function selectTaskConfirmation({ context, containerId, taskId }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  return Object.freeze(await readSelection({ context, containerId, taskId }));
}

function parseConfirmation(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== adminConfirmTaskDefinition.name) throw new ValidationError('Invalid task confirmation proposal');
  return parsed;
}

async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = taskConfirmationContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id, taskId: expected.task_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Task confirmation eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The task or its proofs changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

function assertRecordFits(proposal) {
  // Proof metadata is repeated in the reviewed states and execution receipt.
  // Check the eventual record, not just the smaller pending card, before approval.
  const maxTimestamp = '9999-12-31T23:59:59.999999999+00:00';
  const record = proposalRecordSchema.parse({
    version: 1, scope: '0'.repeat(64), proposal, state: 'executed', turnId: proposal.id,
    auditIds: Object.fromEntries(['proposed', 'approved', 'executed', 'rejected', 'failed']
      .map((stage) => [stage, proposal.id])),
    result: { ...proposal.after, admin_confirmed_at: maxTimestamp, updated_at: maxTimestamp },
  });
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > PROPOSAL_LIMITS.recordBytes) {
    throw new ValidationError('This task has too much text or proof metadata for an approval card. Use the task interface to confirm it.');
  }
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = taskConfirmationContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !taskConfirmationArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected completed task and empty confirmation arguments are required');
  }
  assertSelection(context, selected.data);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  const proposal = proposalSchema.parse({
    id, tool, tier: 3, summary: TASK_CONFIRMATION_SUMMARY,
    parameters: { container_id: selected.data.container_id, task_id: selected.data.task_id },
    before: selected.data, after: taskConfirmationAfter(selected.data), expires_at: expiresAt,
  });
  assertRecordFits(proposal);
  return proposal;
}

async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  await revalidateSelection({ context, selection: parseConfirmation(proposal).before });
}

async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseConfirmation(proposal);
  assertSelection(context, parsed.before);
  const tasks = require('../../services/task.service');
  const row = await tasks.adminConfirmTask({
    workspaceId: context.workspace.id, containerId: parsed.parameters.container_id, taskId: parsed.parameters.task_id,
    actorMemberId: context.member.id, actorDisplayName: context.member.displayName,
    actorCtx: { workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null },
    reviewedConfirmation: { userId: context.userId, isAdmin: context.member.role === 'admin', expected: parsed.before },
  });
  const result = taskConfirmationResultSchema.safeParse(taskConfirmationState(row));
  if (!result.success || !taskConfirmationResultMatches(parsed, result.data)) {
    throw new AppError('The task confirmation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

const getAuditTarget = (proposal) => ({ targetType: 'task', targetId: proposal.parameters.task_id });
const getStatusTarget = (proposal) => ({ ...proposal.parameters });

module.exports = {
  definitions, adminConfirmTaskDefinition, getDefinition, selectTaskConfirmation,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
