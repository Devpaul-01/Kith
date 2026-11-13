const { z } = require('zod');
const {
  AppError, ValidationError, BusinessRuleError,
} = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  PROPOSAL_LIMITS,
  notificationRowSchema,
  notificationSnapshotSchema,
  notificationReadResultSchema,
  notificationBulkSelectionSchema,
  notificationBulkReadResultSchema,
  proposalSchema,
} = require('../validators/proposal.validator');

const markNotificationReadDefinition = Object.freeze({
  name: 'mark_notification_read', tier: 2, minRole: 'member',
  description: 'Propose marking the notification explicitly selected by the user for this message as read. Takes no arguments: you cannot choose or change the target. The server returns an approval card and ends the turn. This tool never changes the notification; only the separate approval endpoint can execute it.',
  parameterSchema: z.object({}).strict(),
});
const markAllNotificationsReadDefinition = Object.freeze({
  name: 'mark_all_notifications_read', tier: 2, minRole: 'member',
  description: 'Propose marking the caller\'s current unread notifications in this workspace as read. Call only when the user explicitly asks to mark all unread notifications read. Takes no arguments: the server binds the approval card to the exact current notification set, and notifications arriving later are excluded. This tool only creates an approval card; it never executes the write.',
  parameterSchema: z.object({}).strict(),
});
const definitions = Object.freeze([markNotificationReadDefinition, markAllNotificationsReadDefinition]);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

async function readSelection({ context, notificationId }) {
  assertAgentContext(context);
  const inbox = require('../../services/notification_inbox.service');
  const id = z.string().uuid().safeParse(notificationId);
  if (!id.success) throw new ValidationError('Invalid notification selection');
  const normalizedId = id.data.toLowerCase();
  const raw = await inbox.getNotification({ notificationId: normalizedId, memberId: context.member.id, workspaceId: context.workspace.id });
  const parsed = notificationRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== normalizedId || parsed.data.workspace_id !== context.workspace.id
      || parsed.data.recipient_id !== context.member.id) {
    throw new AppError('Notification information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  const { recipient_id, workspace_id, ...snapshot } = parsed.data;
  return snapshot;
}

async function selectNotification({ context, notificationId }) {
  await assertCurrentActor(context);
  const selection = await readSelection({ context, notificationId });
  if (selection.is_read) throw new BusinessRuleError('The selected notification is already read.');
  return Object.freeze(selection);
}

async function revalidateOne({ context, snapshot }) {
  assertAgentContext(context);
  const expected = notificationSnapshotSchema.parse(snapshot);
  const current = await readSelection({ context, notificationId: expected.id });
  if (JSON.stringify(current) !== JSON.stringify(expected) || current.is_read) {
    throw new AppError('The notification changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function readBoundNotifications({ context, notificationIds }) {
  assertAgentContext(context);
  const inbox = require('../../services/notification_inbox.service');
  const raw = await inbox.getNotificationsByIds({
    notificationIds, memberId: context.member.id, workspaceId: context.workspace.id,
  });
  const parsed = z.array(notificationRowSchema).max(PROPOSAL_LIMITS.bulkNotificationIds).safeParse(raw);
  if (!parsed.success) {
    throw new AppError('Notification information is unavailable. Please try again.', 503, 'AGENT_PROPOSAL_UNAVAILABLE');
  }
  const rows = new Map(parsed.data.map((row) => [row.id, row]));
  if (parsed.data.length !== notificationIds.length || rows.size !== notificationIds.length || notificationIds.some((id) => {
    const row = rows.get(id);
    return !row || row.workspace_id !== context.workspace.id || row.recipient_id !== context.member.id;
  })) {
    throw new AppError('The notifications changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  return notificationIds.map((id) => rows.get(id));
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  const definition = getDefinition(tool);
  if (!definition || !definition.parameterSchema.safeParse(args).success) {
    throw new ValidationError('Invalid notification proposal');
  }
  await assertCurrentActor(context);
  if (tool === markNotificationReadDefinition.name) {
    const selected = notificationSnapshotSchema.safeParse(selection);
    if (!selected.success) throw new ValidationError('A selected notification is required');
    await revalidateOne({ context, snapshot: selected.data });
    return proposalSchema.parse({
      id, tool, tier: 2, summary: 'Mark the selected notification as read.',
      parameters: { notification_id: selected.data.id }, before: selected.data,
      after: { is_read: true }, expires_at: expiresAt,
    });
  }

  const inbox = require('../../services/notification_inbox.service');
  const snapshot = await inbox.listUnreadNotificationIds({
    memberId: context.member.id, workspaceId: context.workspace.id,
    limit: PROPOSAL_LIMITS.bulkNotificationIds,
  });
  if (snapshot?.count === 0) throw new BusinessRuleError('There are no unread notifications in this workspace.');
  if (Number.isSafeInteger(snapshot?.count) && snapshot.count > PROPOSAL_LIMITS.bulkNotificationIds) {
    throw new BusinessRuleError(`The agent can mark at most ${PROPOSAL_LIMITS.bulkNotificationIds} notifications in one approval. Use the notification inbox for this larger action.`);
  }
  const selected = notificationBulkSelectionSchema.safeParse(snapshot);
  if (!selected.success) {
    throw new AppError('Notification information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  const count = selected.data.count;
  return proposalSchema.parse({
    id, tool, tier: 2,
    summary: `Mark ${count} currently unread notification${count === 1 ? '' : 's'} as read.`,
    parameters: { notification_ids: selected.data.notification_ids },
    before: { unread_count: count }, after: { unread_count: 0 }, expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool === markNotificationReadDefinition.name) {
    return revalidateOne({ context, snapshot: parsed.before });
  }
  const rows = await readBoundNotifications({ context, notificationIds: parsed.parameters.notification_ids });
  if (rows.some((row) => row.is_read)) {
    throw new AppError('The notifications changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function applyNotificationRead({ context, snapshot }) {
  assertAgentContext(context);
  const inbox = require('../../services/notification_inbox.service');
  const expected = notificationSnapshotSchema.parse(snapshot);
  if (expected.is_read) throw new BusinessRuleError('The selected notification is already read.');
  const row = await inbox.markAsRead({
    notificationId: expected.id, memberId: context.member.id, workspaceId: context.workspace.id,
    expectedNotification: expected,
  });
  const result = notificationReadResultSchema.safeParse({ notification_id: row?.id, is_read: row?.is_read, read_at: row?.read_at });
  if (!result.success || row?.id !== expected.id || row?.recipient_id !== context.member.id || row?.workspace_id !== context.workspace.id) {
    throw new AppError('The notification result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

async function applyProposal({ context, proposal }) {
  assertAgentContext(context);
  const parsed = proposalSchema.parse(proposal);
  const inbox = require('../../services/notification_inbox.service');
  if (parsed.tool === markNotificationReadDefinition.name) {
    return applyNotificationRead({ context, snapshot: parsed.before });
  }

  const ids = parsed.parameters.notification_ids;
  const raw = await inbox.markAllAsRead({
    memberId: context.member.id, workspaceId: context.workspace.id, notificationIds: ids,
  });
  const rows = z.array(notificationRowSchema).max(PROPOSAL_LIMITS.bulkNotificationIds).safeParse(raw?.notifications);
  const result = notificationBulkReadResultSchema.safeParse({
    notification_count: ids.length, updated_count: raw?.updated_count,
  });
  if (!rows.success || !result.success) {
    throw new AppError('The notification result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  const returned = new Map(rows.data.map((row) => [row.id, row]));
  if (rows.data.length !== ids.length || returned.size !== ids.length || ids.some((id) => {
    const row = returned.get(id);
    return !row || row.workspace_id !== context.workspace.id || row.recipient_id !== context.member.id || row.is_read !== true;
  })) {
    throw new AppError('The notification result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return {
    targetType: 'notification',
    targetId: proposal.tool === markNotificationReadDefinition.name ? proposal.parameters.notification_id : null,
  };
}

function getStatusTarget(proposal) {
  return proposal.tool === markNotificationReadDefinition.name
    ? { notification_id: proposal.parameters.notification_id }
    : { notification_count: proposal.parameters.notification_ids.length };
}

module.exports = {
  definition: markNotificationReadDefinition,
  definitions,
  markNotificationReadDefinition,
  markAllNotificationsReadDefinition,
  getDefinition,
  getAuditTarget,
  getStatusTarget,
  assertCurrentActor,
  selectNotification,
  createProposalDraft,
  revalidateProposal,
  applyProposal,
  // Backward-compatible aliases for focused unit tests and existing callers.
  revalidateNotification: revalidateOne,
  applyNotificationRead,
};
