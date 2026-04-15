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
// src/routes/notification.routes.js
async function resolveMember(req, res, next) {
  try {
    const { supabaseAdmin } = require('../config/supabase');
    
    // Try multiple sources for workspaceId
    const workspaceId = 
      req.params.workspaceId ||           // From URL params (if available)
      req.query.workspace_id ||           // From query string
      req.body?.workspace_id ||           // From request body
      null;
    
    
    
    let query = supabaseAdmin
      .from('workspace_members')
      .select('id, role, workspace_id, display_name')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .is('deleted_at', null);

    // Only filter by workspaceId if it exists
    if (workspaceId && workspaceId !== 'undefined' && workspaceId !== 'null') {
      query = query.eq('workspace_id', workspaceId);
    }

    const { data, error } = await query
      .order('joined_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('resolveMember error:', error);
      return next(error);
    }

    const member = data?.[0];
    
    if (member) {
      req.member = {
        id: member.id,
        role: member.role,
        workspaceId: member.workspace_id,
        displayName: member.display_name
      };
    } else {
      req.member = { id: null };
    }
    
    console.log('🔍 resolveMember - result:', req.member);
    next();
  } catch (err) {
    console.error('resolveMember catch error:', err);
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
