// src/routes/notification.routes.js
const router = require('express').Router();
const ctrl   = require('../controllers/notification.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const logger = require('../utils/logger');

// Issue 3 fix: moved from inline require inside resolveMember to module-level imports
const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError } = require('../utils/errors');

/**
 * Notifications are user-scoped but operations need a workspace_member id
 * (notifications reference a recipient_id which is a workspace_members.id).
 *
 * This middleware resolves the caller's member id from their active memberships.
 * Optionally scoped to a specific workspace via ?workspace_id=<id>.
 *
 * Issue 3 fix: no-membership case now throws NotFoundError instead of silently
 * passing through with { id: null }, which matches requireMembership behaviour
 * and prevents notification controllers from querying with recipient_id = null.
 */
async function resolveMember(req, res, next) {
  try {
    const workspaceId =
      req.params.workspaceId ||
      req.query.workspace_id ||
      req.body?.workspace_id ||
      null;

    let query = supabaseAdmin
      .from('workspace_members')
      .select('id, role, workspace_id, display_name')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .is('deleted_at', null);

    if (workspaceId && workspaceId !== 'undefined' && workspaceId !== 'null') {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data, error } = await query
      .order('joined_at', { ascending: false })
      .limit(1);

    if (error) {
      logger.error('resolveMember query failed', { userId: req.user?.id, error: error.message });
      return next(error);
    }

    const member = data?.[0];

    // Issue 3 fix: throw NotFoundError instead of setting { id: null } and proceeding
    if (!member) {
      return next(new NotFoundError('No active membership found'));
    }

    req.member = {
      id:          member.id,
      role:        member.role,
      workspaceId: member.workspace_id,
      displayName: member.display_name,
    };

    next();
  } catch (err) {
    logger.error('resolveMember error', { userId: req.user?.id, error: err.message });
    next(err);
  }
}

// ── Routes ────────────────────────────────────────────────────────

// Lightweight unread count — registered BEFORE /:notificationId/read
router.get('/count',      requireAuth, loadDbUser, resolveMember, ctrl.getUnreadCount);
router.get('/',           requireAuth, loadDbUser, resolveMember, ctrl.listNotifications);
router.patch('/read-all', requireAuth, loadDbUser, resolveMember, ctrl.markAllAsRead);
router.patch('/:notificationId/read', requireAuth, loadDbUser, resolveMember, ctrl.markAsRead);

module.exports = router;
