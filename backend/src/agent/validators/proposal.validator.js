const { z } = require('zod');

const MAX_BULK_NOTIFICATION_IDS = 100;
const PROPOSAL_LIMITS = Object.freeze({
  expiryMs: 5 * 60 * 1000,
  retentionSeconds: 24 * 60 * 60,
  redisTimeoutMs: 1000,
  recordBytes: 16 * 1024,
  receiptBatch: 8,
  bulkNotificationIds: MAX_BULK_NOTIFICATION_IDS,
});

const notificationSnapshotSchema = z.object({
  id: z.string().uuid(), type: z.string().min(1).max(100), title: z.string().max(1000),
  is_read: z.boolean(), read_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
}).strict();
const notificationRowSchema = notificationSnapshotSchema.extend({ workspace_id: z.string().uuid(), recipient_id: z.string().uuid() });
const notificationReadResultSchema = z.object({
  notification_id: z.string().uuid(), is_read: z.literal(true), read_at: z.string().datetime({ offset: true }),
}).strict();
const notificationIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_BULK_NOTIFICATION_IDS)
  .refine((ids) => new Set(ids).size === ids.length, 'Notification IDs must be unique');
const notificationBulkSelectionSchema = z.object({
  notification_ids: notificationIdsSchema,
  count: z.number().int().positive().max(MAX_BULK_NOTIFICATION_IDS),
}).strict().refine((value) => value.notification_ids.length === value.count);
const notificationBulkReadResultSchema = z.object({
  notification_count: z.number().int().positive().max(MAX_BULK_NOTIFICATION_IDS),
  updated_count: z.number().int().min(0).max(MAX_BULK_NOTIFICATION_IDS),
}).strict().refine((value) => value.updated_count <= value.notification_count);

const singleNotificationProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('mark_notification_read'), tier: z.literal(2),
  summary: z.literal('Mark the selected notification as read.'),
  parameters: z.object({ notification_id: z.string().uuid() }).strict(),
  before: notificationSnapshotSchema.extend({ is_read: z.literal(false) }),
  after: z.object({ is_read: z.literal(true) }).strict(),
  expires_at: z.string().datetime(),
}).strict();
const allNotificationsProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('mark_all_notifications_read'), tier: z.literal(2),
  summary: z.string().min(1).max(200),
  parameters: z.object({ notification_ids: notificationIdsSchema }).strict(),
  before: z.object({ unread_count: z.number().int().positive().max(MAX_BULK_NOTIFICATION_IDS) }).strict(),
  after: z.object({ unread_count: z.literal(0) }).strict(),
  expires_at: z.string().datetime(),
}).strict();

const proposalSchema = z.union([singleNotificationProposalSchema, allNotificationsProposalSchema]).superRefine((value, ctx) => {
  if (value.tool === 'mark_notification_read' && value.parameters.notification_id !== value.before.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification target mismatch' });
  }
  if (value.tool === 'mark_all_notifications_read') {
    const count = value.parameters.notification_ids.length;
    const expected = `Mark ${count} currently unread notification${count === 1 ? '' : 's'} as read.`;
    if (value.before.unread_count !== count || value.summary !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification set mismatch' });
    }
  }
});

const proposalResultSchema = z.union([notificationReadResultSchema, notificationBulkReadResultSchema]);
const proposalRecordSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), proposal: proposalSchema,
  state: z.enum(['preparing', 'pending', 'approving', 'executing', 'applied', 'executed', 'rejecting', 'rejected', 'failed']),
  turnId: z.string().uuid(),
  auditIds: z.object({ proposed: z.string().uuid(), approved: z.string().uuid(), executed: z.string().uuid(), rejected: z.string().uuid(), failed: z.string().uuid() }).strict(),
  result: proposalResultSchema.optional(),
}).strict().superRefine((record, ctx) => {
  const completed = ['applied', 'executed'].includes(record.state);
  if (completed !== Boolean(record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Proposal result state mismatch' });
    return;
  }
  if (!record.result) return;
  if (record.proposal.tool === 'mark_notification_read') {
    if (!Object.hasOwn(record.result, 'notification_id')
        || record.result.notification_id !== record.proposal.parameters.notification_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification result mismatch' });
    }
  } else if (!Object.hasOwn(record.result, 'notification_count')
      || record.result.notification_count !== record.proposal.parameters.notification_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification set result mismatch' });
  }
});

const emptyApprovalSchema = z.object({}).strict();
const proposalIdSchema = z.string().uuid().transform((id) => id.toLowerCase());
const incompleteStatuses = ['pending', 'expired', 'approval_pending', 'indeterminate', 'rejection_pending', 'rejected', 'failed'];

const commonStatusFields = {
  proposal_id: z.string().uuid(), expires_at: z.string().datetime(), checked_at: z.string().datetime(),
};
const singleStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('mark_notification_read'), notification_id: z.string().uuid(),
}).strict();
const bulkStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('mark_all_notifications_read'),
  notification_count: z.number().int().positive().max(MAX_BULK_NOTIFICATION_IDS),
}).strict();
const proposalStatusSchema = z.union([
  ...incompleteStatuses.map((status) => singleStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => singleStatusFields.extend({ status: z.literal(status), result: notificationReadResultSchema })),
  ...incompleteStatuses.map((status) => bulkStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => bulkStatusFields.extend({ status: z.literal(status), result: notificationBulkReadResultSchema })),
]);

// A missing record never inherits a result or target from historical data.
const unavailableReceiptSchema = z.object({
  proposal_id: z.string().uuid(), status: z.literal('unavailable'), checked_at: z.string().datetime(),
}).strict();
const actionReceiptsSchema = z.array(z.union([proposalStatusSchema, unavailableReceiptSchema]))
  .max(PROPOSAL_LIMITS.receiptBatch).refine((items) => new Set(items.map((item) => item.proposal_id)).size === items.length);
const proposalReferencesSchema = z.array(proposalSchema).max(PROPOSAL_LIMITS.receiptBatch)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length);
const proposedToolResultSchema = z.object({
  kind: z.literal('untrusted_tool_result'),
  data: z.object({ status: z.literal('proposed'), proposal: proposalSchema }).strict(),
}).strict();

module.exports = {
  PROPOSAL_LIMITS,
  notificationSnapshotSchema,
  notificationRowSchema,
  notificationReadResultSchema,
  notificationIdsSchema,
  notificationBulkSelectionSchema,
  notificationBulkReadResultSchema,
  proposalSchema,
  proposalRecordSchema,
  emptyApprovalSchema,
  proposalIdSchema,
  proposalStatusSchema,
  actionReceiptsSchema,
  proposalReferencesSchema,
  proposedToolResultSchema,
};
