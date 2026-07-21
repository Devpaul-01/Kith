// src/routes/workspace.routes.js
//
// One small Router per resource (member/invite/group/container/
// participant/ledger/dispute/task/milestone .routes.js), each mounted
// here at the exact path prefix it occupies.
const router = require('express').Router({ mergeParams: true });

const wCtrl = require('../controllers/workspace.controller');
const dashboardCtrl = require('../controllers/dashboard.controller');
const auditCtrl = require('../controllers/audit.controller');
const searchCtrl = require('../controllers/search.controller');
const lCtrl = require('../controllers/ledger.controller'); // workspace-wide /ledger/export only

const { requireAuth, loadDbUser }   = require('../middleware/auth');
const { requireMembership }         = require('../middleware/workspace');
const { requireAdmin }              = require('../middleware/role');
const { uploadLimiter, userGeneralLimiter } = require('../middleware/rateLimiter');

// Apply auth + active-membership check to EVERY route in this router.
// userGeneralLimiter is mounted here (AFTER requireAuth has populated
// req.user) so it can genuinely key by user id.
router.use(requireAuth, loadDbUser, requireMembership, userGeneralLimiter);

// ── Workspace ──────────────────────────────────────────────────────
router.get('/',           wCtrl.getWorkspace);
router.patch('/',         requireAdmin, wCtrl.updateWorkspace);
router.delete('/',        requireAdmin, wCtrl.deleteWorkspace);
router.get('/dashboard',  dashboardCtrl.getDashboard);
router.get('/settings',   requireAdmin, wCtrl.getSettings);
router.patch('/settings', requireAdmin, wCtrl.updateSettings);

// Cross-entity search across members + containers
router.get('/search', searchCtrl.searchWorkspace);

// Admin broadcast — send admin_announcement to all (or role-filtered) members
router.post('/announce',  requireAdmin, wCtrl.announceToWorkspace);

// Paginated, filterable audit log exposed to admins
router.get('/audit-log',        requireAdmin, auditCtrl.getAuditLog);
router.get('/audit-log/export', requireAdmin, auditCtrl.exportAuditLog);

// Overdue contribution summary across all active containers
router.get('/overdue-summary', requireAdmin, dashboardCtrl.getOverdueSummary);

// Workspace avatar upload
router.post('/avatar-upload-url', requireAdmin, uploadLimiter, wCtrl.getAvatarUploadUrl);

// Workspace-wide ledger export — filterable via ?container_id=.
router.get('/ledger/export', requireAdmin, lCtrl.exportLedger);

// ── Sub-resources ────────────────────────────────────────────────────
router.use('/members',    require('./member.routes'));
router.use('/invites',    require('./workspace-invites.routes'));
router.use('/groups',     require('./group.routes'));
router.use('/containers', require('./container.routes'));
router.use('/disputes',   require('./dispute.routes'));
router.use('/',           require('./milestone.routes'));

module.exports = router;
