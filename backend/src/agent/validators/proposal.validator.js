const { z } = require('zod');
const {
  raiseDisputeTargetSchema, raiseDisputeDataSchema, raiseDisputeContextSchema,
  raisedDisputeStateSchema, disputedEntrySchema, raiseDisputeResultSchema,
  plannedDisputeState,
} = require('../../validators/dispute-raise.validator');
const {
  resolveDisputeTargetSchema, resolveDisputeDataSchema, resolveDisputeContextSchema,
  resolvedDisputeStateSchema, resolvedDisputeEntrySchema, resolveDisputeResultSchema,
  resolutionContextMatches, plannedResolvedDisputeState,
} = require('../../validators/dispute-resolve.validator');
const {
  containerArchiveTargetSchema, containerArchiveContextSchema, containerArchiveResultSchema,
} = require('../../validators/container-archive.validator');
const {
  disputeNoteTargetSchema, disputeNoteDataSchema, disputeNoteContextSchema, disputeNoteResultSchema,
} = require('../../validators/dispute-note.validator');
const {
  taskCreationTargetSchema, taskCreationDataSchema, taskCreationContextSchema,
  taskCreationStateSchema, taskCreationResultSchema, buildTaskCreationState,
} = require('../../validators/task-creation.validator');
const {
  participantAdditionTargetSchema, participantAdditionDataSchema, participantAdditionContextSchema,
  participantAdditionStateSchema, participantAdditionRowSchema, buildParticipantAdditionState,
} = require('../../validators/participant-addition.validator');
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

const taskCreationArgumentsSchema = taskCreationDataSchema.omit({ assigned_to: true });
const taskCreationParametersSchema = taskCreationDataSchema.extend({ container_id: z.string().uuid() });
const taskCreationAfterSchema = taskCreationStateSchema.extend({
  created_at: z.literal('on_approval'), updated_at: z.literal('on_approval'),
});
const TASK_CREATION_SUMMARY = 'Create a task in the selected container.';

function taskCreationParametersFromArgs(selection, args) {
  const selected = taskCreationContextSchema.parse(selection);
  return taskCreationParametersSchema.parse({
    ...taskCreationArgumentsSchema.parse(args), container_id: selected.container_id,
    assigned_to: selected.assignee?.member_id ?? null,
  });
}
function taskCreationAfter(selection, parameters, taskId) {
  const selected = taskCreationContextSchema.parse(selection);
  const { container_id, ...data } = taskCreationParametersSchema.parse(parameters);
  return taskCreationAfterSchema.parse({
    ...buildTaskCreationState({ data, containerId: container_id, taskId, actorMemberId: selected.actor_member_id }),
    created_at: 'on_approval', updated_at: 'on_approval',
  });
}
function taskCreationResultMatches(proposal, result) {
  const parsed = taskCreationResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(taskCreationAfterSchema.parse({
    ...parsed.data, created_at: 'on_approval', updated_at: 'on_approval',
  })) === JSON.stringify(proposal.after);
}

const participantAdditionArgumentsSchema = participantAdditionDataSchema.omit({ workspace_member_id: true });
const participantAdditionParametersSchema = participantAdditionDataSchema.extend({ container_id: z.string().uuid() });
const participantAdditionAfterSchema = participantAdditionStateSchema.extend({ added_at: z.literal('on_approval') });
const PARTICIPANT_ADDITION_SUMMARY = 'Add the selected member to the selected event container.';

function participantAdditionParametersFromArgs(selection, args) {
  const selected = participantAdditionContextSchema.parse(selection);
  return participantAdditionParametersSchema.parse({
    ...participantAdditionArgumentsSchema.parse(args), container_id: selected.container_id,
    workspace_member_id: selected.workspace_member_id,
  });
}
function participantAdditionAfter(selection, parameters, participantId) {
  const selected = participantAdditionContextSchema.parse(selection);
  const { container_id, ...data } = participantAdditionParametersSchema.parse(parameters);
  return participantAdditionAfterSchema.parse({
    ...buildParticipantAdditionState({ data, containerId: container_id,
      participantId, actorMemberId: selected.actor_member_id }), added_at: 'on_approval',
  });
}
function participantAdditionResultMatches(proposal, result) {
  const parsed = participantAdditionRowSchema.safeParse(result);
  return parsed.success && JSON.stringify(participantAdditionAfterSchema.parse({
    ...parsed.data, added_at: 'on_approval',
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

const raiseDisputeArgumentsSchema = raiseDisputeDataSchema;
const raiseDisputeParametersSchema = raiseDisputeDataSchema.extend({ container_id: z.string().uuid(), entry_id: z.string().uuid() });
const raiseDisputeAfterSchema = z.object({
  dispute: raisedDisputeStateSchema.extend({ dispute_id: z.literal('on_confirmation'), raised_at: z.literal('on_confirmation') }),
  entry: disputedEntrySchema,
}).strict();
const DISPUTE_RAISE_SUMMARY = 'Open a dispute on your selected confirmed contribution.';
const SECONDARY_CONFIRMATION = Object.freeze({ method: 'typed', phrase: 'confirm' });
const secondaryConfirmationRequirementSchema = z.object({ method: z.literal('typed'), phrase: z.literal('confirm') }).strict();

function raiseDisputeParametersFromArgs(selection, args) {
  const selected = raiseDisputeContextSchema.parse(selection);
  return raiseDisputeParametersSchema.parse({ ...raiseDisputeArgumentsSchema.parse(args),
    container_id: selected.container_id, entry_id: selected.entry.entry_id });
}
function raiseDisputeAfter(selection, parameters) {
  const selected = raiseDisputeContextSchema.parse(selection);
  const requested = raiseDisputeParametersSchema.parse(parameters);
  return raiseDisputeAfterSchema.parse({
    dispute: { ...plannedDisputeState({ selection: selected, reason: requested.reason }),
      dispute_id: 'on_confirmation', raised_at: 'on_confirmation' },
    entry: { ...selected.entry, status: 'disputed' },
  });
}
function raiseDisputeResultMatches(proposal, result) {
  const parsed = raiseDisputeResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(raiseDisputeAfterSchema.parse({ ...parsed.data,
    dispute: { ...parsed.data.dispute, dispute_id: 'on_confirmation', raised_at: 'on_confirmation' },
  })) === JSON.stringify(proposal.after);
}

const resolveDisputeArgumentsSchema = resolveDisputeDataSchema;
const resolveDisputeParametersSchema = resolveDisputeDataSchema.extend({
  dispute_id: z.string().uuid(), container_id: z.string().uuid(), entry_id: z.string().uuid(),
});
const resolveDisputeAfterSchema = z.object({
  dispute: resolvedDisputeStateSchema.extend({ resolved_at: z.literal('on_confirmation') }),
  entry: resolvedDisputeEntrySchema,
}).strict();
const DISPUTE_RESOLVE_SUMMARY = 'Resolve the selected dispute and mark its contribution resolved.';

function resolveDisputeParametersFromArgs(selection, args) {
  const selected = resolveDisputeContextSchema.parse(selection);
  return resolveDisputeParametersSchema.parse({ ...resolveDisputeArgumentsSchema.parse(args),
    dispute_id: selected.dispute.dispute_id, container_id: selected.container_id, entry_id: selected.entry.entry_id });
}
function resolveDisputeAfter(selection, parameters) {
  const selected = resolveDisputeContextSchema.parse(selection);
  const requested = resolveDisputeParametersSchema.parse(parameters);
  return resolveDisputeAfterSchema.parse({
    dispute: plannedResolvedDisputeState({ selection: selected, resolutionNote: requested.resolution_note }),
    entry: { ...selected.entry, status: 'resolved' },
  });
}
function resolveDisputeResultMatches(proposal, result) {
  const parsed = resolveDisputeResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(resolveDisputeAfterSchema.parse({ ...parsed.data,
    dispute: { ...parsed.data.dispute, resolved_at: 'on_confirmation' },
  })) === JSON.stringify(proposal.after);
}

const disputeNoteArgumentsSchema = disputeNoteDataSchema;
const disputeNoteParametersSchema = disputeNoteDataSchema.extend({ dispute_id: z.string().uuid() });
const disputeNoteAfterSchema = z.object({
  dispute_id: z.string().uuid(),
  note: z.object({
    author_id: z.string().uuid(), note: disputeNoteDataSchema.shape.note, added_at: z.literal('on_execution'),
  }).strict(),
}).strict();
const DISPUTE_NOTE_SUMMARY = 'Add a note to the selected open dispute.';

function disputeNoteParametersFromArgs(selection, args) {
  const selected = disputeNoteContextSchema.parse(selection);
  return disputeNoteParametersSchema.parse({ ...disputeNoteArgumentsSchema.parse(args),
    dispute_id: selected.dispute.dispute_id });
}
function disputeNoteAfter(selection, parameters) {
  const selected = disputeNoteContextSchema.parse(selection);
  const requested = disputeNoteParametersSchema.parse(parameters);
  return disputeNoteAfterSchema.parse({ dispute_id: selected.dispute.dispute_id,
    note: { author_id: selected.actor_member_id, note: requested.note, added_at: 'on_execution' } });
}
function disputeNoteResultMatches(proposal, result) {
  const parsed = disputeNoteResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(disputeNoteAfterSchema.parse({ ...parsed.data,
    note: { ...parsed.data.note, added_at: 'on_execution' },
  })) === JSON.stringify(proposal.after);
}

const containerArchiveArgumentsSchema = z.object({}).strict();
const containerArchiveParametersSchema = z.object({ container_id: z.string().uuid() }).strict();
const containerArchiveAfterSchema = z.object({ container_id: z.string().uuid(), status: z.literal('archived') }).strict();
const CONTAINER_ARCHIVE_SUMMARY = 'Archive the selected container.';

function containerArchiveAfter(selection) {
  const selected = containerArchiveContextSchema.parse(selection);
  return containerArchiveAfterSchema.parse({ container_id: selected.container.container_id, status: 'archived' });
}
function containerArchiveResultMatches(proposal, result) {
  const parsed = containerArchiveResultSchema.safeParse(result);
  return parsed.success && JSON.stringify(containerArchiveAfterSchema.parse({
    container_id: parsed.data.container_id, status: parsed.data.status })) === JSON.stringify(proposal.after);
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
const createTaskProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('create_task'), tier: z.literal(3),
  summary: z.literal(TASK_CREATION_SUMMARY), parameters: taskCreationParametersSchema,
  before: taskCreationContextSchema, after: taskCreationAfterSchema, expires_at: z.string().datetime(),
}).strict();
const raiseDisputeProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('raise_dispute'), tier: z.literal(4),
  summary: z.literal(DISPUTE_RAISE_SUMMARY), parameters: raiseDisputeParametersSchema,
  before: raiseDisputeContextSchema, after: raiseDisputeAfterSchema,
  secondary_confirmation: secondaryConfirmationRequirementSchema, expires_at: z.string().datetime(),
}).strict();
const resolveDisputeProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('resolve_dispute'), tier: z.literal(4),
  summary: z.literal(DISPUTE_RESOLVE_SUMMARY), parameters: resolveDisputeParametersSchema,
  before: resolveDisputeContextSchema, after: resolveDisputeAfterSchema,
  secondary_confirmation: secondaryConfirmationRequirementSchema, expires_at: z.string().datetime(),
}).strict();
const addDisputeNoteProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('add_dispute_note'), tier: z.literal(2),
  summary: z.literal(DISPUTE_NOTE_SUMMARY), parameters: disputeNoteParametersSchema,
  before: disputeNoteContextSchema, after: disputeNoteAfterSchema, expires_at: z.string().datetime(),
}).strict();
const archiveContainerProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('archive_container'), tier: z.literal(3),
  summary: z.literal(CONTAINER_ARCHIVE_SUMMARY), parameters: containerArchiveParametersSchema,
  before: containerArchiveContextSchema, after: containerArchiveAfterSchema, expires_at: z.string().datetime(),
}).strict();
const addParticipantProposalSchema = z.object({
  id: z.string().uuid(), tool: z.literal('add_participants'), tier: z.literal(3),
  summary: z.literal(PARTICIPANT_ADDITION_SUMMARY), parameters: participantAdditionParametersSchema,
  before: participantAdditionContextSchema, after: participantAdditionAfterSchema,
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
  createTaskProposalSchema,
  raiseDisputeProposalSchema,
  resolveDisputeProposalSchema,
  addDisputeNoteProposalSchema,
  archiveContainerProposalSchema,
  addParticipantProposalSchema,
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
  if (value.tool === 'create_task'
      && (value.parameters.container_id !== value.before.container_id
        || value.parameters.assigned_to !== (value.before.assignee?.member_id ?? null)
        || JSON.stringify(value.after) !== JSON.stringify(taskCreationAfter(value.before, value.parameters, value.id)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task creation mismatch' });
  }
  if (value.tool === 'raise_dispute'
      && (value.parameters.container_id !== value.before.container_id
        || value.parameters.entry_id !== value.before.entry.entry_id
        || value.before.entry.workspace_id !== value.before.workspace_id
        || value.before.entry.container_id !== value.before.container_id
        || value.before.entry.contributor_id !== value.before.actor_member_id
        || value.before.entry.original_currency !== value.before.base_currency
        || value.before.entry.original_amount !== value.before.entry.base_amount
        || JSON.stringify(value.after) !== JSON.stringify(raiseDisputeAfter(value.before, value.parameters)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute creation mismatch' });
  }
  if (value.tool === 'resolve_dispute'
      && (value.parameters.dispute_id !== value.before.dispute.dispute_id
        || value.parameters.container_id !== value.before.container_id
        || value.parameters.entry_id !== value.before.entry.entry_id
        || !resolutionContextMatches(value.before)
        || JSON.stringify(value.after) !== JSON.stringify(resolveDisputeAfter(value.before, value.parameters)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute resolution mismatch' });
  }
  if (value.tool === 'add_dispute_note'
      && (value.parameters.dispute_id !== value.before.dispute.dispute_id
        || (value.before.member_role !== 'admin' && value.before.dispute.raised_by !== value.before.actor_member_id)
        || JSON.stringify(value.after) !== JSON.stringify(disputeNoteAfter(value.before, value.parameters)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute note mismatch' });
  }
  if (value.tool === 'archive_container'
      && (value.parameters.container_id !== value.before.container.container_id
        || JSON.stringify(value.after) !== JSON.stringify(containerArchiveAfter(value.before)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Container archive mismatch' });
  }
  if (value.tool === 'add_participants'
      && (value.parameters.container_id !== value.before.container_id
        || value.parameters.workspace_member_id !== value.before.workspace_member_id
        || (value.parameters.money_enabled && !value.before.enable_money)
        || (value.parameters.tasks_enabled && !value.before.enable_tasks)
        || JSON.stringify(value.after) !== JSON.stringify(participantAdditionAfter(value.before, value.parameters, value.id)))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Participant addition mismatch' });
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
  taskCreationResultSchema,
  raiseDisputeResultSchema,
  resolveDisputeResultSchema,
  disputeNoteResultSchema,
  containerArchiveResultSchema,
  participantAdditionRowSchema,
  selfLedgerResultSchema,
  ledgerConfirmationResultSchema,
  containerCreationResultSchema,
  memberCreationResultSchema,
]);
const proposalRecordSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), proposal: proposalSchema,
  state: z.enum(['preparing', 'pending', 'approving', 'awaiting_confirmation', 'confirming', 'executing', 'applied', 'executed', 'rejecting', 'rejected', 'failed']),
  turnId: z.string().uuid(),
  auditIds: z.object({ proposed: z.string().uuid(), approved: z.string().uuid(), executed: z.string().uuid(), rejected: z.string().uuid(), failed: z.string().uuid(), confirmed: z.string().uuid().optional() }).strict(),
  conversationId: z.string().uuid().nullable().optional(),
  secondaryConfirmation: z.object({ token: z.string().uuid(), confirmedAt: z.string().datetime().optional() }).strict().optional(),
  result: proposalResultSchema.optional(),
}).strict().superRefine((record, ctx) => {
  const sensitive = record.proposal.tier === 4;
  if (sensitive !== Boolean(record.secondaryConfirmation) || sensitive !== Boolean(record.auditIds.confirmed)
      || sensitive !== Object.hasOwn(record, 'conversationId')
      || (!sensitive && ['awaiting_confirmation', 'confirming'].includes(record.state))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Secondary confirmation record mismatch' });
  }
  if (sensitive && record.secondaryConfirmation) {
    const confirmed = Boolean(record.secondaryConfirmation.confirmedAt);
    if ((['confirming', 'executing', 'applied', 'executed'].includes(record.state) && !confirmed)
        || (['preparing', 'pending', 'approving', 'awaiting_confirmation', 'rejecting', 'rejected'].includes(record.state) && confirmed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Secondary confirmation state mismatch' });
    }
  }
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
  } else if (record.proposal.tool === 'create_task'
      && !taskCreationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Task creation result mismatch' });
  } else if (record.proposal.tool === 'raise_dispute'
      && !raiseDisputeResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute creation result mismatch' });
  } else if (record.proposal.tool === 'resolve_dispute'
      && !resolveDisputeResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute resolution result mismatch' });
  } else if (record.proposal.tool === 'add_dispute_note'
      && !disputeNoteResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Dispute note result mismatch' });
  } else if (record.proposal.tool === 'archive_container'
      && !containerArchiveResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Container archive result mismatch' });
  } else if (record.proposal.tool === 'add_participants'
      && !participantAdditionResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Participant addition result mismatch' });
  } else if (record.proposal.tool === 'create_container'
      && !containerCreationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Container creation result mismatch' });
  } else if (record.proposal.tool === 'create_member'
      && !memberCreationResultMatches(record.proposal, record.result)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Member creation result mismatch' });
  }
});

const emptyApprovalSchema = z.object({}).strict();
const secondaryConfirmationSchema = z.object({
  confirmation: z.literal('confirm'), confirmation_token: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();
const secondaryApprovalReplySchema = z.object({
  proposal_id: z.string().uuid(), status: z.literal('awaiting_confirmation'),
  confirmation_token: z.string().uuid(), expires_at: z.string().datetime(),
}).strict();
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
const taskCreationStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('create_task'), task_id: z.string().uuid(),
  container_id: z.string().uuid(), assigned_to: z.string().uuid().nullable(),
}).strict();
const raiseDisputeStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('raise_dispute'), container_id: z.string().uuid(), entry_id: z.string().uuid(),
}).strict();
const resolveDisputeStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('resolve_dispute'), dispute_id: z.string().uuid(),
  container_id: z.string().uuid(), entry_id: z.string().uuid(),
}).strict();
const disputeNoteStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('add_dispute_note'), dispute_id: z.string().uuid(),
}).strict();
const containerArchiveStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('archive_container'), container_id: z.string().uuid(),
}).strict();
const participantAdditionStatusFields = z.object({
  ...commonStatusFields, tool: z.literal('add_participants'),
  participant_id: z.string().uuid(), container_id: z.string().uuid(), workspace_member_id: z.string().uuid(),
}).strict();
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
  ...[...incompleteStatuses, 'awaiting_confirmation', 'confirmation_pending']
    .map((status) => resolveDisputeStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => resolveDisputeStatusFields.extend({
    status: z.literal(status), result: resolveDisputeResultSchema,
  }).refine((value) => value.dispute_id === value.result.dispute.dispute_id
      && value.entry_id === value.result.entry.entry_id
      && value.entry_id === value.result.dispute.ledger_entry_id
      && value.container_id === value.result.entry.container_id
      && value.result.dispute.workspace_id === value.result.entry.workspace_id
      && value.result.dispute.raised_by === value.result.entry.contributor_id,
  'Dispute resolution receipt target mismatch')),
  ...incompleteStatuses.map((status) => containerArchiveStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => containerArchiveStatusFields.extend({
    status: z.literal(status), result: containerArchiveResultSchema,
  }).refine((value) => value.container_id === value.result.container_id, 'Container archive receipt target mismatch')),
  ...incompleteStatuses.map((status) => disputeNoteStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => disputeNoteStatusFields.extend({
    status: z.literal(status), result: disputeNoteResultSchema,
  }).refine((value) => value.dispute_id === value.result.dispute_id, 'Dispute note receipt target mismatch')),
  ...[...incompleteStatuses, 'awaiting_confirmation', 'confirmation_pending']
    .map((status) => raiseDisputeStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => raiseDisputeStatusFields.extend({
    status: z.literal(status), result: raiseDisputeResultSchema,
  }).refine((value) => value.entry_id === value.result.entry.entry_id
      && value.entry_id === value.result.dispute.ledger_entry_id
      && value.container_id === value.result.entry.container_id
      && value.result.dispute.workspace_id === value.result.entry.workspace_id
      && value.result.dispute.raised_by === value.result.entry.contributor_id,
  'Dispute creation receipt target mismatch')),
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
  ...incompleteStatuses.map((status) => taskCreationStatusFields.extend({ status: z.literal(status) })
    .refine((value) => value.task_id === value.proposal_id, 'Task creation receipt ID mismatch')),
  ...['audit_pending', 'executed'].map((status) => taskCreationStatusFields.extend({
    status: z.literal(status), result: taskCreationResultSchema,
  }).refine((value) => value.task_id === value.proposal_id && value.task_id === value.result.task_id
      && value.container_id === value.result.container_id && value.assigned_to === value.result.assigned_to,
  'Task creation receipt target mismatch')),
  ...incompleteStatuses.map((status) => participantAdditionStatusFields.extend({ status: z.literal(status) })),
  ...['audit_pending', 'executed'].map((status) => participantAdditionStatusFields.extend({
    status: z.literal(status), result: participantAdditionRowSchema,
  }).refine((value) => value.participant_id === value.proposal_id && value.participant_id === value.result.participant_id
      && value.container_id === value.result.container_id && value.workspace_member_id === value.result.workspace_member_id,
  'Participant addition receipt target mismatch')),
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
  containerArchiveTargetSchema, containerArchiveContextSchema, containerArchiveArgumentsSchema,
  containerArchiveParametersSchema, containerArchiveAfterSchema, containerArchiveResultSchema,
  containerArchiveAfter, containerArchiveResultMatches, CONTAINER_ARCHIVE_SUMMARY,
  disputeNoteTargetSchema, disputeNoteDataSchema, disputeNoteContextSchema,
  disputeNoteArgumentsSchema, disputeNoteParametersSchema, disputeNoteAfterSchema, disputeNoteResultSchema,
  disputeNoteParametersFromArgs, disputeNoteAfter, disputeNoteResultMatches, DISPUTE_NOTE_SUMMARY,
  resolveDisputeTargetSchema, resolveDisputeDataSchema, resolveDisputeContextSchema,
  resolveDisputeArgumentsSchema, resolveDisputeParametersSchema, resolveDisputeAfterSchema, resolveDisputeResultSchema,
  resolveDisputeParametersFromArgs, resolveDisputeAfter, resolveDisputeResultMatches, DISPUTE_RESOLVE_SUMMARY,
  raiseDisputeTargetSchema, raiseDisputeDataSchema, raiseDisputeContextSchema,
  raiseDisputeArgumentsSchema, raiseDisputeParametersSchema, raiseDisputeAfterSchema, raiseDisputeResultSchema,
  raiseDisputeParametersFromArgs, raiseDisputeAfter, raiseDisputeResultMatches,
  DISPUTE_RAISE_SUMMARY, SECONDARY_CONFIRMATION, secondaryConfirmationSchema, secondaryApprovalReplySchema,
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
  taskCreationTargetSchema,
  taskCreationDataSchema,
  taskCreationContextSchema,
  taskCreationArgumentsSchema,
  taskCreationAfterSchema,
  taskCreationResultSchema,
  taskCreationParametersFromArgs,
  taskCreationAfter,
  taskCreationResultMatches,
  TASK_CREATION_SUMMARY,
  participantAdditionTargetSchema,
  participantAdditionDataSchema,
  participantAdditionContextSchema,
  participantAdditionArgumentsSchema,
  participantAdditionRowSchema,
  participantAdditionParametersFromArgs,
  participantAdditionAfter,
  participantAdditionResultMatches,
  PARTICIPANT_ADDITION_SUMMARY,
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
