const { z } = require('zod');
const {
  taskConfirmationStateSchema, taskConfirmationSnapshotSchema, taskConfirmationContextSchema,
} = require('../../validators/task-confirmation.validator');
const { updateProfileSchema, profileSnapshotFieldsSchema, contactSnapshotSchema } = require('../../validators/auth.validator');
const {
  eventContainerCreationDataSchema, containerCreationContextSchema,
  eventContainerCreationStateSchema, buildEventContainerCreationState,
} = require('../../validators/workspace.validator');
const {
  memberCreationDataSchema, memberCreationContextSchema,
  memberCreationStateSchema, buildMemberCreationState,
} = require('../../validators/member-creation.validator');
const {
  createTaskSchema, updateTaskSchema, selfLedgerAmountSchema,
  selfLedgerContextSchema, selfLedgerSubmissionDataSchema,
  entryConfirmationSnapshotSchema, entryConfirmationContextSchema,
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

const taskConfirmationArgumentsSchema = z.object({}).strict();
const taskConfirmationAfterSchema = taskConfirmationSnapshotSchema.extend({
  admin_confirmed_at: z.literal('on_approval'), admin_confirmed_by: z.string().uuid(),
  updated_at: z.literal('on_approval'),
});
const taskConfirmationResultSchema = taskConfirmationStateSchema.extend({
  admin_confirmed_at: z.string().max(35).datetime({ offset: true }), admin_confirmed_by: z.string().uuid(),
});
const TASK_CONFIRMATION_SUMMARY = 'Confirm completion of the selected task.';

function taskConfirmationAfter(selection) {
  const selected = taskConfirmationContextSchema.parse(selection);
  const snapshot = Object.fromEntries(Object.keys(taskConfirmationSnapshotSchema.shape)
    .map((field) => [field, selected[field]]));
  return taskConfirmationAfterSchema.parse({
    ...snapshot, admin_confirmed_at: 'on_approval', admin_confirmed_by: selected.actor_member_id,
    updated_at: 'on_approval',
  });
}

function taskConfirmationResultMatches(proposal, result) {
  const parsed = taskConfirmationResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(taskConfirmationAfterSchema.parse({
    ...parsed.data, admin_confirmed_at: 'on_approval', updated_at: 'on_approval',
  })) === JSON.stringify(proposal.after);
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

const ledgerConfirmationTargetSchema = z.object({
  container_id: z.string().uuid().transform((id) => id.toLowerCase()),
  entry_id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();
const ledgerConfirmationArgumentsSchema = z.object({}).strict();
const ledgerConfirmationAfterSchema = entryConfirmationSnapshotSchema.extend({
  status: z.literal('confirmed'), confirmed_by: z.string().uuid(),
  confirmed_at: z.literal('on_approval'),
});
const ledgerConfirmationResultSchema = ledgerConfirmationAfterSchema.extend({
  confirmed_at: z.string().datetime({ offset: true }),
});
const LEDGER_CONFIRMATION_SUMMARY = 'Confirm the selected contribution and lock its financial details.';

function ledgerConfirmationAfter(selection) {
  const selected = entryConfirmationContextSchema.parse(selection);
  const snapshot = Object.fromEntries(Object.keys(entryConfirmationSnapshotSchema.shape)
    .map((field) => [field, selected[field]]));
  return ledgerConfirmationAfterSchema.parse({
    ...snapshot, status: 'confirmed', confirmed_by: selected.actor_member_id,
    confirmed_at: 'on_approval',
  });
}

function ledgerConfirmationResultMatches(proposal, result) {
  const parsed = ledgerConfirmationResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(ledgerConfirmationAfterSchema.parse({
    ...parsed.data, confirmed_at: 'on_approval',
  })) === JSON.stringify(proposal.after);
}

const containerCreationArgumentsSchema = eventContainerCreationDataSchema
  .omit({ container_type: true }).partial({
    subtitle: true, description: true, enable_money: true, enable_tasks: true,
    event_date: true, event_type: true, event_type_category: true,
  });
const containerCreationBeforeSchema = containerCreationContextSchema.extend({ container: z.null() });
const containerCreationAfterSchema = eventContainerCreationStateSchema.extend({
  created_at: z.literal('on_approval'), updated_at: z.literal('on_approval'),
});
const containerCreationResultSchema = eventContainerCreationStateSchema.extend({
  created_at: z.string().max(35).datetime({ offset: true }),
  updated_at: z.string().max(35).datetime({ offset: true }),
}).refine((value) => Date.parse(value.created_at) === Date.parse(value.updated_at),
  'A new container must use the same creation and update time');
const CONTAINER_CREATION_SUMMARY = 'Create a new event container in this workspace.';

function containerCreationParametersFromArgs(args) {
  return eventContainerCreationDataSchema.parse({
    ...containerCreationArgumentsSchema.parse(args), container_type: 'event',
  });
}

function containerCreationAfter(context, data, containerId) {
  const current = containerCreationContextSchema.parse(context);
  return containerCreationAfterSchema.parse({
    ...buildEventContainerCreationState({ data, workspaceId: current.workspace_id,
      containerId, actorMemberId: current.actor_member_id }),
    created_at: 'on_approval', updated_at: 'on_approval',
  });
}

function containerCreationResultMatches(proposal, result) {
  const parsed = containerCreationResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(containerCreationAfterSchema.parse({
    ...parsed.data, created_at: 'on_approval', updated_at: 'on_approval',
  })) === JSON.stringify(proposal.after);
}

const memberCreationArgumentsSchema = memberCreationDataSchema.partial({
  is_proxy: true, relationship_to_head: true, relationship_category: true,
  date_of_birth: true, admin_notes: true,
});
const memberCreationBeforeSchema = memberCreationContextSchema.extend({ member: z.null() });
const memberCreationAfterSchema = memberCreationStateSchema.extend({
  joined_at: z.literal('on_approval'),
  created_at: z.literal('on_approval'), updated_at: z.literal('on_approval'),
});
const memberCreationResultSchema = memberCreationStateSchema.extend({
  joined_at: z.string().max(35).datetime({ offset: true }),
  created_at: z.string().max(35).datetime({ offset: true }),
  updated_at: z.string().max(35).datetime({ offset: true }),
}).refine((value) => Date.parse(value.joined_at) === Date.parse(value.created_at)
    && Date.parse(value.created_at) === Date.parse(value.updated_at),
  'A new member must use the same joining, creation and update time');
const MEMBER_CREATION_SUMMARY = 'Create a new member in this workspace.';

function memberCreationParametersFromArgs(args) {
  return memberCreationDataSchema.parse(memberCreationArgumentsSchema.parse(args));
}

function memberCreationAfter(context, data, memberId) {
  const current = memberCreationContextSchema.parse(context);
  return memberCreationAfterSchema.parse({
    ...buildMemberCreationState({ data, workspaceId: current.workspace_id,
      memberId, actorMemberId: current.actor_member_id }),
    joined_at: 'on_approval', created_at: 'on_approval', updated_at: 'on_approval',
  });
}

function memberCreationResultMatches(proposal, result) {
  const parsed = memberCreationResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(memberCreationAfterSchema.parse({
    ...parsed.data, joined_at: 'on_approval', created_at: 'on_approval', updated_at: 'on_approval',
  })) === JSON.stringify(proposal.after);
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
const confirmTaskProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('admin_confirm_task'), tier: z.literal(3),
  summary: z.literal(TASK_CONFIRMATION_SUMMARY), parameters: taskTargetSchema,
  before: taskConfirmationContextSchema, after: taskConfirmationAfterSchema,
  expires_at: z.string().datetime(),
}).strict();
const createSelfLedgerProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('create_ledger_entry'), tier: z.literal(2),
  summary: z.literal(SELF_LEDGER_SUMMARY), parameters: selfLedgerParametersSchema,
  before: selfLedgerContextSchema, after: selfLedgerAfterSchema,
  expires_at: z.string().datetime(),
}).strict();
const confirmLedgerEntryProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('confirm_ledger_entry'), tier: z.literal(3),
  summary: z.literal(LEDGER_CONFIRMATION_SUMMARY), parameters: ledgerConfirmationTargetSchema,
  before: entryConfirmationContextSchema, after: ledgerConfirmationAfterSchema,
  expires_at: z.string().datetime(),
}).strict();
const createContainerProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('create_container'), tier: z.literal(3),
  summary: z.literal(CONTAINER_CREATION_SUMMARY), parameters: eventContainerCreationDataSchema,
  before: containerCreationBeforeSchema, after: containerCreationAfterSchema,
  expires_at: z.string().datetime(),
}).strict();
const createMemberProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('create_member'), tier: z.literal(3),
  summary: z.literal(MEMBER_CREATION_SUMMARY), parameters: memberCreationDataSchema,
  before: memberCreationBeforeSchema, after: memberCreationAfterSchema,
  expires_at: z.string().datetime(),
}).strict();

const proposalSchema = z.union([
  singleNotificationProposalSchema, allNotificationsProposalSchema, updateProfileProposalSchema, deleteContactProposalSchema,
  updateTaskProposalSchema,
  confirmTaskProposalSchema,
  createSelfLedgerProposalSchema,
  confirmLedgerEntryProposalSchema,
  createContainerProposalSchema,
  createMemberProposalSchema,
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
  if (value.tool === 'admin_confirm_task'
      && (value.parameters.task_id !== value.before.task_id
        || value.parameters.container_id !== value.before.container_id
        || JSON.stringify(value.after) !== JSON.stringify(taskConfirmationAfter(value.before)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task confirmation mismatch' });
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
  if (value.tool === 'confirm_ledger_entry') {
    if (value.parameters.entry_id !== value.before.entry_id
        || value.parameters.container_id !== value.before.container_id
        || value.before.original_currency !== value.before.base_currency
        || value.before.original_amount !== value.before.base_amount
        || JSON.stringify(value.after) !== JSON.stringify(ledgerConfirmationAfter(value.before))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ledger confirmation mismatch' });
    }
  }
  if (value.tool === 'create_container') {
    const { container, ...context } = value.before;
    if (value.after.container_id !== value.id
        || JSON.stringify(value.after) !== JSON.stringify(containerCreationAfter(context, value.parameters, value.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Container creation mismatch' });
    }
  }
  if (value.tool === 'create_member') {
    const { member, ...context } = value.before;
    if (value.after.member_id !== value.id
        || JSON.stringify(value.after) !== JSON.stringify(memberCreationAfter(context, value.parameters, value.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Member creation mismatch' });
    }
  }
});

const proposalResultSchema = z.union([
  notificationReadResultSchema, notificationBulkReadResultSchema, profileUpdateResultSchema, contactDeletionResultSchema,
  taskProgressResultSchema,
  taskConfirmationResultSchema,
  selfLedgerResultSchema,
  ledgerConfirmationResultSchema,
  containerCreationResultSchema,
  memberCreationResultSchema,
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
  } else if (record.proposal.tool === 'confirm_ledger_entry'
      && !ledgerConfirmationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ledger confirmation result mismatch' });
  } else if (record.proposal.tool === 'admin_confirm_task'
      && !taskConfirmationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task confirmation result mismatch' });
  } else if (record.proposal.tool === 'create_container'
      && !containerCreationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Container creation result mismatch' });
  } else if (record.proposal.tool === 'create_member'
      && !memberCreationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Member creation result mismatch' });
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
const taskConfirmationStatusFields = taskStatusFields.extend({ tool: z.literal('admin_confirm_task') });
const selfLedgerStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('create_ledger_entry'),
  container_id: z.string().uuid(), contributor_id: z.string().uuid(),
}).strict();
const ledgerConfirmationStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('confirm_ledger_entry'),
  container_id: z.string().uuid(), entry_id: z.string().uuid(),
}).strict();
const containerCreationStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('create_container'), container_id: z.string().uuid(),
}).strict();
const memberCreationStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('create_member'), member_id: z.string().uuid(),
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
  ...incompleteStatuses.map((status) => taskConfirmationStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => taskConfirmationStatusFields.extend({
    status: z.literal(status), result: taskConfirmationResultSchema,
  }).refine((value) => value.task_id === value.result.task_id && value.container_id === value.result.container_id,
    'Task confirmation receipt target mismatch')),
  ...incompleteStatuses.map((status) => selfLedgerStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => selfLedgerStatusFields.extend({ status: z.literal(status), result: selfLedgerResultSchema })),
  ...incompleteStatuses.map((status) => ledgerConfirmationStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => ledgerConfirmationStatusFields.extend({
    status: z.literal(status), result: ledgerConfirmationResultSchema,
  }).refine((value) => value.entry_id === value.result.entry_id && value.container_id === value.result.container_id,
    'Ledger confirmation receipt target mismatch')),
  ...incompleteStatuses.map((status) => containerCreationStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => containerCreationStatusFields.extend({
    status: z.literal(status), result: containerCreationResultSchema,
  }).refine((value) => value.container_id === value.result.container_id,
    'Container creation receipt target mismatch')),
  ...incompleteStatuses.map((status) => memberCreationStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => memberCreationStatusFields.extend({
    status: z.literal(status), result: memberCreationResultSchema,
  }).refine((value) => value.member_id === value.proposal_id && value.member_id === value.result.member_id,
    'Member creation receipt target mismatch')),
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
  taskConfirmationContextSchema,
  taskConfirmationArgumentsSchema,
  taskConfirmationAfterSchema,
  taskConfirmationResultSchema,
  taskConfirmationAfter,
  taskConfirmationResultMatches,
  TASK_CONFIRMATION_SUMMARY,
  selfLedgerContextSchema,
  selfLedgerArgumentsSchema,
  selfLedgerParametersSchema,
  selfLedgerResultSchema,
  selfLedgerParametersFromArgs,
  selfLedgerAfter,
  SELF_LEDGER_SUMMARY,
  entryConfirmationContextSchema,
  ledgerConfirmationTargetSchema,
  ledgerConfirmationArgumentsSchema,
  ledgerConfirmationAfterSchema,
  ledgerConfirmationResultSchema,
  ledgerConfirmationAfter,
  ledgerConfirmationResultMatches,
  LEDGER_CONFIRMATION_SUMMARY,
  containerCreationContextSchema,
  containerCreationArgumentsSchema,
  containerCreationBeforeSchema,
  containerCreationAfterSchema,
  containerCreationResultSchema,
  containerCreationParametersFromArgs,
  containerCreationAfter,
  containerCreationResultMatches,
  CONTAINER_CREATION_SUMMARY,
  memberCreationContextSchema,
  memberCreationArgumentsSchema,
  memberCreationBeforeSchema,
  memberCreationAfterSchema,
  memberCreationResultSchema,
  memberCreationParametersFromArgs,
  memberCreationAfter,
  memberCreationResultMatches,
  MEMBER_CREATION_SUMMARY,
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
