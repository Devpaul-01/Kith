const { z } = require('zod');
const { updateProfileSchema, profileSnapshotFieldsSchema, contactSnapshotSchema } = require('../../validators/auth.validator');
const {
  createTaskSchema, updateTaskSchema, selfLedgerAmountSchema,
  selfLedgerContextSchema, selfLedgerSubmissionDataSchema,
} = require('../../validators/ledger.validator');

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

const PROFILE_UPDATE_FIELDS = Object.freeze([
  'full_name', 'bio', 'country_of_residence', 'timezone',
  'preferred_language', 'push_enabled', 'email_digest_enabled',
]);
const PROFILE_FIELD_LABELS = Object.freeze({
  full_name: 'full name',
  bio: 'bio',
  country_of_residence: 'country of residence',
  timezone: 'timezone',
  preferred_language: 'preferred language',
  push_enabled: 'push notifications',
  email_digest_enabled: 'email digests',
});
const profileFieldSchema = z.enum(PROFILE_UPDATE_FIELDS);
const profileUpdateParametersSchema = updateProfileSchema
  .pick(Object.fromEntries(PROFILE_UPDATE_FIELDS.map((field) => [field, true]))).strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one profile field is required');
const profileBeforeSchema = profileSnapshotFieldsSchema.partial().extend({
  updated_at: z.string().datetime({ offset: true }),
}).strict();
const profileUpdateResultSchema = z.object({
  changes: profileUpdateParametersSchema,
  updated_at: z.string().datetime({ offset: true }),
}).strict();
const contactDeletionResultSchema = z.object({
  contact_id: z.string().uuid(), deleted: z.literal(true),
}).strict();

const taskTargetSchema = z.object({
  container_id: z.string().uuid().transform((id) => id.toLowerCase()),
  task_id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();
const taskCompletionNoteSchema = updateTaskSchema.shape.completion_note.unwrap().unwrap().nullable();
const taskSnapshotSchema = z.object({
  id: z.string().uuid(), container_id: z.string().uuid(),
  title: createTaskSchema.shape.title,
  assigned_to: z.string().uuid(),
  status: updateTaskSchema.shape.status.unwrap(),
  completion_note: taskCompletionNoteSchema,
  completed_at: z.string().datetime({ offset: true }).nullable(),
  completed_by: z.string().uuid().nullable(),
  admin_confirmed_at: z.string().datetime({ offset: true }).nullable(),
  updated_at: z.string().datetime({ offset: true }),
}).strict();
const taskProgressSnapshotSchema = taskSnapshotSchema.extend({
  status: z.enum(['pending', 'in_progress', 'overdue']),
  admin_confirmed_at: z.null(),
});
const taskProgressParametersSchema = updateTaskSchema.pick({ status: true, completion_note: true }).extend({
  status: z.enum(['in_progress', 'completed']),
}).strict();
const taskProgressAfterSchema = taskProgressParametersSchema.extend({
  completion_note: taskCompletionNoteSchema,
});
const taskProgressResultSchema = z.object({
  task_id: z.string().uuid(), container_id: z.string().uuid(),
  status: taskProgressParametersSchema.shape.status,
  completion_note: taskCompletionNoteSchema,
  completed_at: z.string().datetime({ offset: true }).nullable(),
  updated_at: z.string().datetime({ offset: true }),
}).strict().refine((value) => value.status !== 'completed' || value.completed_at !== null,
  'Completed tasks must have a completion timestamp');

function taskProposalSummary(parameters) {
  return parameters.status === 'completed'
    ? 'Mark the selected task as completed.'
    : 'Set the selected task to in progress.';
}

const selfLedgerArgumentsSchema = z.object({
  amount: selfLedgerAmountSchema,
  currency: selfLedgerSubmissionDataSchema.shape.original_currency,
  payment_method: selfLedgerSubmissionDataSchema.shape.payment_method.removeDefault().optional(),
  note: selfLedgerSubmissionDataSchema.shape.note.removeDefault().optional(),
}).strict();
const selfLedgerParametersSchema = selfLedgerSubmissionDataSchema.extend({ container_id: z.string().uuid() });
const selfLedgerAfterSchema = selfLedgerParametersSchema.extend({
  payment_method: selfLedgerSubmissionDataSchema.shape.payment_method.removeDefault(),
  note: selfLedgerSubmissionDataSchema.shape.note.removeDefault(),
  cycle_id: z.null(), is_crypto: z.literal(false),
  status: z.literal('pending'), confirmed_at: z.null(), confirmed_by: z.null(),
});
const selfLedgerResultSchema = selfLedgerAfterSchema.extend({
  entry_id: z.string().uuid(), recorded_at: z.string().datetime({ offset: true }),
});
const SELF_LEDGER_SUMMARY = 'Submit your contribution to the selected container for admin review.';

function selfLedgerParametersFromArgs(selection, args) {
  const selected = selfLedgerContextSchema.parse(selection);
  const requested = selfLedgerArgumentsSchema.parse(args);
  return selfLedgerParametersSchema.parse({
    container_id: selected.container_id, contributor_id: selected.contributor_id,
    entry_type: 'contribution', original_amount: requested.amount, base_amount: requested.amount,
    original_currency: requested.currency, payment_method: requested.payment_method ?? null,
    note: requested.note ?? null, cycle_id: null, is_crypto: false,
  });
}

function selfLedgerAfter(parameters) {
  return selfLedgerAfterSchema.parse({ ...parameters, status: 'pending', confirmed_at: null, confirmed_by: null });
}

function profileProposalSummary(parameters) {
  const labels = PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(parameters, field))
    .map((field) => PROFILE_FIELD_LABELS[field]);
  const joined = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return `Update your Kith account profile: ${joined}.`;
}

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
const updateProfileProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('update_my_profile'), tier: z.literal(2),
  summary: z.string().min(1).max(300),
  parameters: profileUpdateParametersSchema,
  before: profileBeforeSchema,
  after: profileUpdateParametersSchema,
  expires_at: z.string().datetime(),
}).strict();
const deleteContactProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('delete_contact'), tier: z.literal(2),
  summary: z.literal('Delete the selected Kith account contact.'),
  parameters: z.object({ contact_id: z.string().uuid() }).strict(),
  before: contactSnapshotSchema,
  after: z.object({ deleted: z.literal(true) }).strict(),
  expires_at: z.string().datetime(),
}).strict();
const updateTaskProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('update_task'), tier: z.literal(2),
  summary: z.string().min(1).max(200),
  parameters: taskTargetSchema.merge(taskProgressParametersSchema),
  before: taskProgressSnapshotSchema,
  after: taskProgressAfterSchema,
  expires_at: z.string().datetime(),
}).strict();
const createSelfLedgerProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('create_ledger_entry'), tier: z.literal(2),
  summary: z.literal(SELF_LEDGER_SUMMARY), parameters: selfLedgerParametersSchema,
  before: selfLedgerContextSchema, after: selfLedgerAfterSchema,
  expires_at: z.string().datetime(),
}).strict();

const proposalSchema = z.union([
  singleNotificationProposalSchema, allNotificationsProposalSchema, updateProfileProposalSchema, deleteContactProposalSchema,
  updateTaskProposalSchema,
  createSelfLedgerProposalSchema,
]).superRefine((value, ctx) => {
  if (value.tool === 'mark_notification_read' && value.parameters.notification_id !== value.before.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification target mismatch' });
  }
  if (value.tool === 'delete_contact' && value.parameters.contact_id !== value.before.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Contact target mismatch' });
  }
  if (value.tool === 'mark_all_notifications_read') {
    const count = value.parameters.notification_ids.length;
    const expected = `Mark ${count} currently unread notification${count === 1 ? '' : 's'} as read.`;
    if (value.before.unread_count !== count || value.summary !== expected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification set mismatch' });
    }
  }
  if (value.tool === 'update_my_profile') {
    const parameterKeys = PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(value.parameters, field));
    const beforeKeys = PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(value.before, field));
    const afterKeys = PROFILE_UPDATE_FIELDS.filter((field) => Object.hasOwn(value.after, field));
    if (JSON.stringify(beforeKeys) !== JSON.stringify(parameterKeys)
        || JSON.stringify(afterKeys) !== JSON.stringify(parameterKeys)
        || JSON.stringify(value.after) !== JSON.stringify(value.parameters)
        || value.summary !== profileProposalSummary(value.parameters)
        || parameterKeys.some((field) => Object.is(value.before[field], value.after[field]))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Profile change mismatch' });
    }
  }
  if (value.tool === 'update_task') {
    const note = Object.hasOwn(value.parameters, 'completion_note')
      ? value.parameters.completion_note : value.before.completion_note;
    if (value.parameters.task_id !== value.before.id
        || value.parameters.container_id !== value.before.container_id
        || value.after.status !== value.parameters.status
        || value.after.completion_note !== note
        || value.summary !== taskProposalSummary(value.parameters)
        || (value.after.status === value.before.status && value.after.completion_note === value.before.completion_note)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task progress change mismatch' });
    }
  }
  if (value.tool === 'create_ledger_entry') {
    if (value.parameters.container_id !== value.before.container_id
        || value.parameters.contributor_id !== value.before.contributor_id
        || value.parameters.original_currency !== value.before.base_currency
        || value.parameters.original_amount !== value.parameters.base_amount
        || JSON.stringify(value.after) !== JSON.stringify(selfLedgerAfter(value.parameters))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Self contribution mismatch' });
    }
  }
});

const proposalResultSchema = z.union([
  notificationReadResultSchema, notificationBulkReadResultSchema, profileUpdateResultSchema, contactDeletionResultSchema,
  taskProgressResultSchema,
  selfLedgerResultSchema,
]);
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
  } else if (record.proposal.tool === 'mark_all_notifications_read'
      && (!Object.hasOwn(record.result, 'notification_count')
        || record.result.notification_count !== record.proposal.parameters.notification_ids.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification set result mismatch' });
  } else if (record.proposal.tool === 'update_my_profile'
      && (!Object.hasOwn(record.result, 'changes')
        || JSON.stringify(record.result.changes) !== JSON.stringify(record.proposal.after))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Profile result mismatch' });
  } else if (record.proposal.tool === 'delete_contact'
      && (!Object.hasOwn(record.result, 'contact_id')
        || record.result.contact_id !== record.proposal.parameters.contact_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Contact result mismatch' });
  } else if (record.proposal.tool === 'update_task'
      && (!Object.hasOwn(record.result, 'task_id')
        || record.result.task_id !== record.proposal.parameters.task_id
        || record.result.container_id !== record.proposal.parameters.container_id
        || record.result.status !== record.proposal.after.status
        || record.result.completion_note !== record.proposal.after.completion_note
        || (record.result.status === 'in_progress' && record.result.completed_at !== record.proposal.before.completed_at))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task progress result mismatch' });
  } else if (record.proposal.tool === 'create_ledger_entry') {
    const result = selfLedgerResultSchema.safeParse(record.result);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Self contribution result mismatch' });
    } else {
      const { entry_id, recorded_at, ...after } = result.data;
      if (JSON.stringify(after) !== JSON.stringify(record.proposal.after)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Self contribution result mismatch' });
      }
    }
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
const profileStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('update_my_profile'),
  profile_fields: z.array(profileFieldSchema).min(1).max(PROFILE_UPDATE_FIELDS.length)
    .refine((fields) => new Set(fields).size === fields.length),
}).strict();
const contactStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('delete_contact'), contact_id: z.string().uuid(),
}).strict();
const taskStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('update_task'),
  task_id: z.string().uuid(), container_id: z.string().uuid(),
}).strict();
const selfLedgerStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('create_ledger_entry'),
  container_id: z.string().uuid(), contributor_id: z.string().uuid(),
}).strict();
const proposalStatusSchema = z.union([
  ...incompleteStatuses.map((status) => singleStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => singleStatusFields.extend({ status: z.literal(status), result: notificationReadResultSchema })),
  ...incompleteStatuses.map((status) => bulkStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => bulkStatusFields.extend({ status: z.literal(status), result: notificationBulkReadResultSchema })),
  ...incompleteStatuses.map((status) => profileStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => profileStatusFields.extend({ status: z.literal(status), result: profileUpdateResultSchema })),
  ...incompleteStatuses.map((status) => contactStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => contactStatusFields.extend({ status: z.literal(status), result: contactDeletionResultSchema })),
  ...incompleteStatuses.map((status) => taskStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => taskStatusFields.extend({ status: z.literal(status), result: taskProgressResultSchema })),
  ...incompleteStatuses.map((status) => selfLedgerStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => selfLedgerStatusFields.extend({ status: z.literal(status), result: selfLedgerResultSchema })),
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
  PROFILE_UPDATE_FIELDS,
  profileFieldSchema,
  profileUpdateParametersSchema,
  profileBeforeSchema,
  profileUpdateResultSchema,
  contactSnapshotSchema,
  contactDeletionResultSchema,
  taskTargetSchema,
  taskSnapshotSchema,
  taskProgressSnapshotSchema,
  taskProgressParametersSchema,
  taskProgressResultSchema,
  taskProposalSummary,
  selfLedgerContextSchema,
  selfLedgerArgumentsSchema,
  selfLedgerParametersSchema,
  selfLedgerResultSchema,
  selfLedgerParametersFromArgs,
  selfLedgerAfter,
  SELF_LEDGER_SUMMARY,
  profileProposalSummary,
  proposalSchema,
  proposalRecordSchema,
  emptyApprovalSchema,
  proposalIdSchema,
  proposalStatusSchema,
  actionReceiptsSchema,
  proposalReferencesSchema,
  proposedToolResultSchema,
};
