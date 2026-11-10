const { z } = require('zod');

const PROPOSAL_LIMITS = Object.freeze({ expiryMs: 5 * 60 * 1000, retentionSeconds: 24 * 60 * 60, redisTimeoutMs: 1000, recordBytes: 16 * 1024 });
const notificationSnapshotSchema = z.object({
  id: z.string().uuid(), type: z.string().min(1).max(100), title: z.string().max(1000),
  is_read: z.boolean(), read_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
}).strict();
const notificationRowSchema = notificationSnapshotSchema.extend({ workspace_id: z.string().uuid(), recipient_id: z.string().uuid() });
const notificationReadResultSchema = z.object({
  notification_id: z.string().uuid(), is_read: z.literal(true), read_at: z.string().datetime({ offset: true }),
}).strict();
const proposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('mark_notification_read'), tier: z.literal(2),
  summary: z.literal('Mark the selected notification as read.'),
  parameters: z.object({ notification_id: z.string().uuid() }).strict(),
  before: notificationSnapshotSchema.extend({ is_read: z.literal(false) }),
  after: z.object({ is_read: z.literal(true) }).strict(),
  expires_at: z.string().datetime(),
}).strict().refine((value) => value.parameters.notification_id === value.before.id);
const proposalRecordSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), proposal: proposalSchema,
  state: z.enum(['preparing', 'pending', 'approving', 'executing', 'applied', 'executed', 'rejecting', 'rejected', 'failed']),
  turnId: z.string().uuid(),
  auditIds: z.object({ proposed: z.string().uuid(), approved: z.string().uuid(), executed: z.string().uuid(), rejected: z.string().uuid(), failed: z.string().uuid() }).strict(),
  result: notificationReadResultSchema.optional(),
}).strict().refine((record) => {
  const completed = ['applied', 'executed'].includes(record.state);
  return completed === Boolean(record.result)
    && (!record.result || record.result.notification_id === record.proposal.parameters.notification_id);
});
const emptyApprovalSchema = z.object({}).strict();
const proposalIdSchema = z.string().uuid().transform((id) => id.toLowerCase());

module.exports = { PROPOSAL_LIMITS, notificationSnapshotSchema, notificationRowSchema, notificationReadResultSchema, proposalSchema, proposalRecordSchema, emptyApprovalSchema, proposalIdSchema };
