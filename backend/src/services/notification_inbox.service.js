// src/services/notification_inbox.service.js
//
// Named notification_inbox.service.js (not notification.service.js)
// because that name is already taken by the central notification
// *sender*. This module is the distinct concern of a recipient
// reading/managing their own inbox — list, unread count, mark-as-read,
// mark-all-as-read.

const { supabaseAdmin } = require('../config/supabase');
const {
  AppError, NotFoundError, ConflictError, ValidationError,
} = require('../utils/errors');

const NOTIFICATION_PREVIEW_FIELDS = 'id, workspace_id, recipient_id, type, title, is_read, read_at, created_at';
const unavailable = () => new AppError('Notifications are unavailable. Please try again.', 503, 'NOTIFICATIONS_UNAVAILABLE');

async function getNotification({ notificationId, memberId, workspaceId }) {
  let query = supabaseAdmin.from('notifications').select(NOTIFICATION_PREVIEW_FIELDS)
    .eq('id', notificationId).eq('recipient_id', memberId);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query.maybeSingle();
  if (error) throw unavailable();
  if (!data) throw new NotFoundError('Notification not found');
  return data;
}

function unreadQuery({ memberId, workspaceId }) {
  let query = supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true })
    .eq('recipient_id', memberId).eq('is_read', false);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  return query;
}

async function listNotifications({ memberId, page, perPage, offset, isRead, workspaceId }) {
  let query = supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('recipient_id', memberId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + perPage - 1);

  if (isRead     !== undefined) query = query.eq('is_read', isRead === true || isRead === 'true');
  if (workspaceId)              query = query.eq('workspace_id', workspaceId);

  const [{ data: notifications, count, error }, { count: unreadCount, error: unreadError }] = await Promise.all([
    query,
    unreadQuery({ memberId, workspaceId }),
  ]);
  if (error || unreadError || !Array.isArray(notifications)
      || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(unreadCount) || unreadCount < 0) {
    throw new AppError('Notifications are unavailable. Please try again.', 503, 'NOTIFICATIONS_UNAVAILABLE');
  }

  return {
    notifications,
    unread_count: unreadCount,
    count,
  };
}

async function getUnreadCount({ memberId, workspaceId }) {
  const { count, error } = await unreadQuery({ memberId, workspaceId });

  if (error || !Number.isSafeInteger(count) || count < 0) {
    throw new AppError('Notifications are unavailable. Please try again.', 503, 'NOTIFICATIONS_UNAVAILABLE');
  }
  return count;
}

function normalizeNotificationIds(notificationIds) {
  if (!Array.isArray(notificationIds) || notificationIds.length === 0 || notificationIds.length > 500
      || notificationIds.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(notificationIds).size !== notificationIds.length) {
    throw new ValidationError('Invalid notification IDs');
  }
  return [...notificationIds];
}

async function listUnreadNotificationIds({ memberId, workspaceId, limit }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError('Invalid notification limit');
  }
  let query = supabaseAdmin.from('notifications').select('id', { count: 'exact' })
    .eq('recipient_id', memberId).eq('is_read', false)
    .order('created_at', { ascending: false }).order('id', { ascending: true })
    .range(0, limit);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, count, error } = await query;
  if (error || !Array.isArray(data) || !Number.isSafeInteger(count) || count < 0
      || data.some((row) => !row || typeof row.id !== 'string')
      || new Set(data.map((row) => row.id)).size !== data.length
      || (count <= limit && data.length !== count)) {
    throw unavailable();
  }
  return { notification_ids: data.slice(0, limit).map((row) => row.id), count };
}

async function getNotificationsByIds({ notificationIds, memberId, workspaceId }) {
  const ids = normalizeNotificationIds(notificationIds);
  let query = supabaseAdmin.from('notifications').select(NOTIFICATION_PREVIEW_FIELDS)
    .eq('recipient_id', memberId).in('id', ids);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw unavailable();
  return data;
}

async function markAsRead({ notificationId, memberId, workspaceId, expectedNotification }) {
  let query = supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('recipient_id', memberId);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  if (expectedNotification) {
    // Conditional writes preserve the timestamp and reject a changed preview.
    // Agent callers must supply the full snapshot loaded by getNotification.
    query = query.eq('is_read', false).eq('title', expectedNotification.title)
      .eq('type', expectedNotification.type).eq('created_at', expectedNotification.created_at);
    query = expectedNotification.read_at === null
      ? query.is('read_at', null) : query.eq('read_at', expectedNotification.read_at);
  }
  const { data, error } = await query.select().maybeSingle();

  if (error) throw unavailable();
  if (!data && expectedNotification) throw new ConflictError('Notification changed. Please request a new proposal.');
  if (!data) throw new NotFoundError('Notification not found');

  return data;
}

async function markAllAsRead({ memberId, workspaceId, notificationIds }) {
  const now = new Date().toISOString();
  const ids = notificationIds === undefined ? null : normalizeNotificationIds(notificationIds);

  let query = supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: now })
    .eq('recipient_id', memberId)
    .eq('is_read', false)
    .select('id');

  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  if (ids) query = query.in('id', ids);

  const { data, error } = await query;
  if (error || !Array.isArray(data) || data.some((row) => !row || typeof row.id !== 'string')) throw unavailable();

  if (ids) {
    const updatedIds = data.map((row) => row.id);
    if (new Set(updatedIds).size !== updatedIds.length || updatedIds.some((id) => !ids.includes(id))) throw unavailable();
    // A target may become read between revalidation and the update. That is
    // still a successful end state, but it must be verified after the write.
    const notifications = await getNotificationsByIds({ notificationIds: ids, memberId, workspaceId });
    const returned = new Map(notifications.map((notification) => [notification?.id, notification]));
    if (notifications.length !== ids.length || returned.size !== ids.length
        || ids.some((id) => returned.get(id)?.is_read !== true)) {
      throw new AppError('The notification update could not be confirmed.', 503, 'NOTIFICATIONS_UPDATE_UNCONFIRMED');
    }
    return { updated_count: updatedIds.length, notifications };
  }

  return data.length;
}

module.exports = {
  listNotifications, getUnreadCount, getNotification, listUnreadNotificationIds,
  getNotificationsByIds, markAsRead, markAllAsRead,
};
