const { z } = require('zod');

const timestamp = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

const containerArchiveTargetSchema = z.object({
  container_id: uuid.transform((id) => id.toLowerCase()),
}).strict();
const containerArchiveCallerSchema = z.object({
  workspaceId: uuid, containerId: uuid, callerId: uuid, userId: uuid,
}).strict();

// Only active or completed containers can be archived, matching the ordinary route.
// updated_at binds the exact reviewed version for the atomic compare-and-set.
const archivableContainerSchema = z.object({
  container_id: uuid, name: z.string().min(1).max(200), container_type: z.enum(['event', 'recurring']),
  status: z.enum(['active', 'completed']), enable_money: z.boolean(), enable_tasks: z.boolean(),
  updated_at: timestamp,
}).strict();
const containerArchiveContextSchema = z.object({
  workspace_id: uuid, actor_member_id: uuid, member_role: z.literal('admin'),
  container: archivableContainerSchema,
}).strict();
const containerArchiveReadRowSchema = z.object({
  id: uuid, workspace_id: uuid, name: z.string().min(1).max(200), container_type: z.enum(['event', 'recurring']),
  status: z.enum(['active', 'completed', 'archived', 'cancelled']), enable_money: z.boolean(), enable_tasks: z.boolean(),
  updated_at: timestamp, deleted_at: z.null(),
}).strip();
const containerArchiveResultSchema = z.object({
  container_id: uuid, status: z.literal('archived'), updated_at: timestamp,
}).strict();
const containerArchiveRowSchema = z.object({
  id: uuid, status: z.literal('archived'), updated_at: timestamp,
}).passthrough();

module.exports = {
  containerArchiveTargetSchema, containerArchiveCallerSchema, archivableContainerSchema,
  containerArchiveContextSchema, containerArchiveReadRowSchema, containerArchiveResultSchema, containerArchiveRowSchema,
};
