const { z } = require('zod');
const { AppError, ForbiddenError, ValidationError, BusinessRuleError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { notificationRowSchema, notificationSnapshotSchema, notificationReadResultSchema } = require('../validators/proposal.validator');

const definition = Object.freeze({
  name: 'mark_notification_read', tier: 2, minRole: 'member',
  description: 'Propose marking the notification explicitly selected by the user for this message as read. Takes no arguments: you cannot choose or change the target. The server returns an approval card and ends the turn. This tool never changes the notification; only the separate approval endpoint can execute it.',
  parameterSchema: z.object({}).strict(),
});

async function assertCurrentActor(context) {
  assertAgentContext(context);
  const members = require('../../services/member.service');
  const member = await members.getActiveMembership({ workspaceId: context.workspace.id, userId: context.userId });
  if (member.id !== context.member.id || member.workspace_id !== context.workspace.id || member.user_id !== context.userId
      || member.is_active !== true || member.role !== context.member.role) {
    throw new ForbiddenError('Workspace membership changed. Please retry.');
  }
}

async function readSelection({ context, notificationId }) {
  assertAgentContext(context);
  const inbox = require('../../services/notification_inbox.service');
  const id = z.string().uuid().safeParse(notificationId);
  if (!id.success) throw new ValidationError('Invalid notification selection');
  const raw = await inbox.getNotification({ notificationId: id.data.toLowerCase(), memberId: context.member.id, workspaceId: context.workspace.id });
  const parsed = notificationRowSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== id.data.toLowerCase() || parsed.data.workspace_id !== context.workspace.id
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

async function revalidateNotification({ context, snapshot }) {
  assertAgentContext(context);
  const expected = notificationSnapshotSchema.parse(snapshot);
  const current = await readSelection({ context, notificationId: expected.id });
  if (JSON.stringify(current) !== JSON.stringify(expected) || current.is_read) {
    throw new AppError('The notification changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function applyNotificationRead({ context, snapshot }) {
  assertAgentContext(context);
  const inbox = require('../../services/notification_inbox.service');
  const expected = notificationSnapshotSchema.parse(snapshot);
  if (expected.is_read) throw new BusinessRuleError('The selected notification is already read.');
  const row = await inbox.markAsRead({
    notificationId: expected.id, memberId: context.member.id, workspaceId: context.workspace.id, expectedNotification: expected,
  });
  const parsed = notificationReadResultSchema.safeParse({ notification_id: row?.id, is_read: row?.is_read, read_at: row?.read_at });
  if (!parsed.success || row?.id !== expected.id || row?.recipient_id !== context.member.id || row?.workspace_id !== context.workspace.id) {
    throw new AppError('The notification result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return parsed.data;
}

module.exports = { definition, assertCurrentActor, selectNotification, revalidateNotification, applyNotificationRead };
