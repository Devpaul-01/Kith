const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listNotificationsArgsSchema, unreadCountArgsSchema, MAX_NOTIFICATION_PAGE } = require('../validators/notification-tools.validator');

async function listNotifications({ context, args }) {
  assertAgentContext(context);
  const parsed = listNotificationsArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid notification arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    memberId: context.member.id, workspaceId: context.workspace.id,
    isRead: parsed.data.is_read, page, perPage, offset,
  };
  const inbox = require('../../services/notification_inbox.service');
  const { notifications, unread_count, count } = await inbox.listNotifications(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    notifications: notifications.map((notification) => ({
      id: notification.id, type: notification.type, title: notification.title, body: notification.body,
      reference_type: notification.reference_type, reference_id: notification.reference_id,
      is_read: notification.is_read, read_at: notification.read_at, created_at: notification.created_at,
    })),
    unread_count,
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_NOTIFICATION_PAGE ? page + 1 : null },
  };
}

async function getUnreadCount({ context, args }) {
  assertAgentContext(context);
  const parsed = unreadCountArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid notification arguments', null, parsed.error.issues);
  const parameters = { memberId: context.member.id, workspaceId: context.workspace.id };
  const inbox = require('../../services/notification_inbox.service');
  return { unread_count: await inbox.getUnreadCount(parameters) };
}

module.exports = { listNotifications, getUnreadCount };
