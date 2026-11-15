const { z } = require('zod');
const { createTaskSchema, updateTaskSchema, confirmProofSchema } = require('./ledger.validator');

const timestamp = z.string().max(35).datetime({ offset: true });
const taskProofSnapshotSchema = z.object({
  url: confirmProofSchema.shape.file_path.max(2048),
  name: confirmProofSchema.shape.name,
  size: confirmProofSchema.shape.size.safe(),
  mime_type: confirmProofSchema.shape.mime_type.max(255),
  uploaded_by: z.string().uuid(), uploaded_at: timestamp,
}).strict();

// Keep every stored task field in the reviewed state, including the exact
// ordered proof metadata. No file contents or signed URLs are fetched here.
const taskConfirmationStateSchema = z.object({
  task_id: z.string().uuid(), container_id: z.string().uuid(),
  title: createTaskSchema.shape.title,
  description: createTaskSchema.shape.description.unwrap().nullable(),
  assigned_to: z.string().uuid().nullable(), due_date: z.string().date().nullable(),
  status: z.literal('completed'),
  completed_at: timestamp, completed_by: z.string().uuid().nullable(),
  completion_note: updateTaskSchema.shape.completion_note.unwrap().unwrap().nullable(),
  proofs: z.array(taskProofSnapshotSchema), sort_order: z.number().int().nullable(),
  created_by: z.string().uuid(), created_at: timestamp, updated_at: timestamp,
  deleted_at: z.null(), admin_confirmed_at: timestamp.nullable(),
  admin_confirmed_by: z.string().uuid().nullable(), admin_note: z.string().max(2000).nullable(),
}).strict();
const taskConfirmationSnapshotSchema = taskConfirmationStateSchema.extend({
  admin_confirmed_at: z.null(), admin_confirmed_by: z.null(),
});
const taskConfirmationContextSchema = taskConfirmationSnapshotSchema.extend({
  workspace_id: z.string().uuid(), actor_member_id: z.string().uuid(), member_role: z.literal('admin'),
  container_name: z.string().min(1).max(100), container_status: z.literal('active'),
  enable_tasks: z.literal(true), container_updated_at: timestamp,
}).refine((value) => value.proofs.every((proof) => {
  const prefix = `workspaces/${value.workspace_id}/task-proofs/${value.task_id}/`;
  return proof.url.startsWith(prefix) && proof.url.length > prefix.length
    && !proof.url.includes('..') && !/[\\\x00-\x1f?#]/.test(proof.url);
}), 'Proof references must belong to the selected workspace and task');

const taskConfirmationCallerSchema = z.object({
  workspaceId: z.string().uuid(), containerId: z.string().uuid(), taskId: z.string().uuid(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const reviewedTaskConfirmationSchema = z.object({
  userId: z.string().uuid(), isAdmin: z.boolean(), expected: taskConfirmationContextSchema,
}).strict();

function taskConfirmationState(row) {
  return Object.fromEntries(Object.keys(taskConfirmationStateSchema.shape)
    .map((field) => [field, field === 'task_id' ? row?.id : row?.[field]]));
}

module.exports = {
  taskConfirmationStateSchema, taskConfirmationSnapshotSchema, taskConfirmationContextSchema,
  taskConfirmationCallerSchema, reviewedTaskConfirmationSchema, taskConfirmationState,
};
