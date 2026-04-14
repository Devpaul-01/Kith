// src/routes/notification.routes.js
const router = require('express').Router();
const ctrl   = require('../controllers/notification.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const { query } = require('../config/database');

/**
 * Notifications are user-scoped but operations need a workspace_member id
 * (notifications reference a recipient_id which is a workspace_members.id).
 *
 * This middleware resolves the caller's member id from their active memberships.
 * Optionally scoped to a specific workspace via ?workspace_id=<id>.
 */
async function resolveMember(req, res, next) {
  try {
    const workspaceId =
      req.query.workspace_id ||
      req.body?.workspace_id ||
      null;

    let sql    = `SELECT id FROM workspace_members
                  WHERE user_id=$1 AND is_active=TRUE AND deleted_at IS NULL`;
    const params = [req.user.id];

    if (workspaceId) {
      sql += ` AND workspace_id=$2`;
      params.push(workspaceId);
    }

    sql += ` ORDER BY joined_at ASC LIMIT 1`;

    const result = await query(sql, params);
    req.member = { id: result.rows[0]?.id || null };
    next();
  } catch (err) {
    next(err);
  }
}

// ── Routes ────────────────────────────────────────────────────────

// Lightweight unread count — poll every 30 seconds for the badge in the app shell
// Must be registered BEFORE /:notificationId/read to avoid route shadowing
router.get('/count', requireAuth, loadDbUser, resolveMember, ctrl.getUnreadCount);

// Full paginated notification list
router.get('/', requireAuth, loadDbUser, resolveMember, ctrl.listNotifications);

// Mark all (optionally workspace-scoped) as read
router.patch('/read-all', requireAuth, loadDbUser, resolveMember, ctrl.markAllAsRead);

// Mark a single notification as read
router.patch('/:notificationId/read', requireAuth, loadDbUser, resolveMember, ctrl.markAsRead);

module.exports = router;
