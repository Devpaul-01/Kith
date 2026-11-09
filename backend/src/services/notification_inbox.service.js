// src/services/notification_inbox.service.js
//
// Named notification_inbox.service.js (not notification.service.js)
// because that name is already taken by the central notification
// *sender*. This module is the distinct concern of a recipient
// reading/managing their own inbox — list, unread count, mark-as-read,
// mark-all-as-read.

const { supabaseAdmin } = require('../config/supabase');
const { AppError, NotFoundError } = require('../utils/errors');

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

async function markAsRead({ notificationId, memberId }) {
  const { data, error } = await supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('recipient_id', memberId)
    .select()
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Notification not found');

  return data;
}

async function markAllAsRead({ memberId, workspaceId }) {
  const now = new Date().toISOString();

  let query = supabaseAdmin
    .from('notifications')
    .update({ is_read: true, read_at: now })
    .eq('recipient_id', memberId)
    .eq('is_read', false)
    .select('id');

  if (workspaceId) query = query.eq('workspace_id', workspaceId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data || []).length;
}

module.exports = { listNotifications, getUnreadCount, markAsRead, markAllAsRead };
