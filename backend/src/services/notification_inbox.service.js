// src/services/notification_inbox.service.js
//
// Extracted from notification.controller.js as part of the service-layer
// refactor. Named notification_inbox.service.js (not notification.service.js)
// because that name is already taken by the central notification *sender*
// (services/notification.service.js, used by nearly every other
// controller/worker to dispatch notifications). This module is the
// distinct concern of a recipient reading/managing their own inbox —
// list, unread count, mark-as-read, mark-all-as-read.

const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError } = require('../utils/errors');

async function listNotifications({ memberId, page, perPage, offset, isRead, workspaceId }) {
  let query = supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('recipient_id', memberId)
    .order('created_at', { ascending: false })
    .range(offset, offset + perPage - 1);

  if (isRead     !== undefined) query = query.eq('is_read', isRead === 'true');
  if (workspaceId)              query = query.eq('workspace_id', workspaceId);

  const [{ data: notifications, count }, { count: unreadCount }] = await Promise.all([
    query,
    supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', memberId).eq('is_read', false),
  ]);

  return {
    notifications: notifications || [],
    unread_count:  unreadCount || 0,
    count:         count || 0,
  };
}

async function getUnreadCount({ memberId }) {
  const { count, error } = await supabaseAdmin
    .from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', memberId).eq('is_read', false);

  if (error) throw new Error(error.message);
  return count || 0;
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
