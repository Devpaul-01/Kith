// src/controllers/notification.controller.js
const { supabaseAdmin } = require('../config/supabase');
const { success, paginate } = require('../utils/response');
const { NotFoundError } = require('../utils/errors');
const { getPagination } = require('../utils/pagination');

async function listNotifications(req, res, next) {
  try {
    const memberId = req.member.id;
    const { page, perPage, offset } = getPagination(req.query);

    let query = supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('recipient_id', memberId)
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    if (req.query.is_read     !== undefined) query = query.eq('is_read',     req.query.is_read === 'true');
    if (req.query.workspace_id)              query = query.eq('workspace_id', req.query.workspace_id);

    const [{ data: notifications, count }, { count: unreadCount }] = await Promise.all([
      query,
      supabaseAdmin.from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', memberId).eq('is_read', false),
    ]);

    paginate(res, { notifications: notifications || [], unread_count: unreadCount || 0 }, count || 0, page, perPage);
  } catch (err) { next(err); }
}

async function getUnreadCount(req, res, next) {
  try {
    const { count, error } = await supabaseAdmin
      .from('notifications').select('*', { count: 'exact', head: true }).eq('recipient_id', req.member.id).eq('is_read', false);

    if (error) throw new Error(error.message);
    success(res, { unread_count: count || 0 });
  } catch (err) { next(err); }
}

async function markAsRead(req, res, next) {
  try {
    const { notificationId } = req.params;
    const memberId           = req.member.id;

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('recipient_id', memberId)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Notification not found');

    success(res, { notification: data });
  } catch (err) { next(err); }
}

async function markAllAsRead(req, res, next) {
  try {
    const memberId        = req.member.id;
    const workspaceFilter = req.body?.workspace_id;
    const now             = new Date().toISOString();

    let query = supabaseAdmin
      .from('notifications')
      .update({ is_read: true, read_at: now })
      .eq('recipient_id', memberId)
      .eq('is_read', false)
      .select('id');

    if (workspaceFilter) query = query.eq('workspace_id', workspaceFilter);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    success(res, { updated_count: (data || []).length });
  } catch (err) { next(err); }
}

module.exports = { listNotifications, getUnreadCount, markAsRead, markAllAsRead };
