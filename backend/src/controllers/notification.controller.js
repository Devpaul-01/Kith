// src/controllers/notification.controller.js
//
// Service-layer refactor: inbox logic now lives in
// services/notification_inbox.service.js (kept distinct from
// services/notification.service.js, the central sender used elsewhere in
// the app — see that file's header comment for why they aren't merged).

const { success, paginate } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const inboxService = require('../services/notification_inbox.service');

async function listNotifications(req, res, next) {
  try {
    const memberId = req.member.id;
    const { page, perPage, offset } = getPagination(req.query);

    const { notifications, unread_count, count } = await inboxService.listNotifications({
      memberId, page, perPage, offset,
      isRead: req.query.is_read,
      workspaceId: req.query.workspace_id,
    });

    paginate(res, { notifications, unread_count }, count, page, perPage);
  } catch (err) { next(err); }
}

async function getUnreadCount(req, res, next) {
  try {
    const count = await inboxService.getUnreadCount({ memberId: req.member.id });
    success(res, { unread_count: count });
  } catch (err) { next(err); }
}

async function markAsRead(req, res, next) {
  try {
    const { notificationId } = req.params;
    const notification = await inboxService.markAsRead({ notificationId, memberId: req.member.id });
    success(res, { notification });
  } catch (err) { next(err); }
}

async function markAllAsRead(req, res, next) {
  try {
    const updatedCount = await inboxService.markAllAsRead({
      memberId: req.member.id,
      workspaceId: req.body?.workspace_id,
    });
    success(res, { updated_count: updatedCount });
  } catch (err) { next(err); }
}

module.exports = { listNotifications, getUnreadCount, markAsRead, markAllAsRead };
