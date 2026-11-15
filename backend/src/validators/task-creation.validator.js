const { z } = require('zod');
const { createTaskSchema } = require('./ledger.validator');
const { taskConfirmationStateSchema } = require('./task-confirmation.validator');

const timestamp = z.string().max(35).datetime({ offset: true });
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const supportedText = (field) => field.refine(
  (value) => !unsupportedText.test(value), 'Text contains unsupported characters',
);
const fields = createTaskSchema.shape;
const taskCreationTargetSchema = z.object({
  container_id: z.string().uuid().transform((id) => id.toLowerCase()),
  assignee_id: z.string().uuid().transform((id) => id.toLowerCase()).nullable().default(null),
}).strict();
const taskCreationDataSchema = z.object({
  title: supportedText(fields.title.trim().min(1)),
  description: supportedText(fields.description.unwrap().trim())
    .transform((value) => value || null).nullable().default(null),
  assigned_to: fields.assigned_to.unwrap().unwrap().nullable().default(null),
  due_date: fields.due_date.unwrap().unwrap().nullable().default(null),
}).strict();
const taskCreationAssigneeSchema = z.object({
  member_id: z.string().uuid(), display_name: z.string().min(1).max(200),
  member_role: z.enum(['member', 'admin']), is_active: z.literal(true), is_proxy: z.literal(false),
  member_updated_at: timestamp, participant_id: z.string().uuid(),
  participant_added_at: timestamp, tasks_enabled: z.literal(true),
}).strict();
const taskCreationContextSchema = z.object({
  workspace_id: z.string().uuid(), workspace_name: z.string().min(1).max(200), workspace_updated_at: timestamp,
  actor_member_id: z.string().uuid(), member_role: z.literal('admin'),
  container_id: z.string().uuid(), container_name: z.string().min(1).max(100),
  container_type: z.enum(['event', 'recurring']), container_status: z.literal('active'),
  enable_tasks: z.literal(true), container_updated_at: timestamp,
  assignee: taskCreationAssigneeSchema.nullable(), task: z.null(),
}).strict();

// Reuse every stored task column, replacing completion state with exact new-task defaults.
// Execution timestamps stay outside the planned business state.
const taskCreationStateSchema = taskConfirmationStateSchema.omit({ created_at: true, updated_at: true }).extend({
  status: z.literal('pending'), completed_at: z.null(), completed_by: z.null(), completion_note: z.null(),
  proofs: z.array(z.never()).length(0), sort_order: z.literal(0),
  admin_confirmed_at: z.null(), admin_confirmed_by: z.null(), admin_note: z.null(),
});
const taskCreationRowSchema = taskCreationStateSchema.extend({ created_at: timestamp, updated_at: timestamp });
const taskCreationResultSchema = taskCreationRowSchema.refine(
  (value) => Date.parse(value.created_at) === Date.parse(value.updated_at),
  'Task creation timestamps must match',
);
const taskCreationCallerSchema = z.object({
  workspaceId: z.string().uuid(), containerId: z.string().uuid(), assigneeId: z.string().uuid().nullable(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const reviewedTaskCreationSchema = z.object({
  userId: z.string().uuid(), isAdmin: z.boolean(), taskId: z.string().uuid(), expected: taskCreationContextSchema,
}).strict();

function buildTaskCreationState({ data, containerId, taskId, actorMemberId }) {
  return taskCreationStateSchema.parse({
    ...taskCreationDataSchema.parse(data), task_id: taskId, container_id: containerId,
    status: 'pending', completed_at: null, completed_by: null, completion_note: null,
    proofs: [], sort_order: 0, created_by: actorMemberId, deleted_at: null,
    admin_confirmed_at: null, admin_confirmed_by: null, admin_note: null,
  });
}
function taskCreationState(row) {
  return Object.fromEntries(Object.keys(taskCreationRowSchema.shape)
    .map((field) => [field, field === 'task_id' ? row?.id : row?.[field]]));
}

module.exports = {
  taskCreationTargetSchema, taskCreationDataSchema, taskCreationAssigneeSchema, taskCreationContextSchema,
  taskCreationStateSchema, taskCreationRowSchema, taskCreationResultSchema, taskCreationCallerSchema,
  reviewedTaskCreationSchema, buildTaskCreationState, taskCreationState,
};
