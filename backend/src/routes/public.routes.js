// src/routes/public.routes.js
//
// All routes in this file are publicly accessible — no auth required
// (except /invites/:token/accept which needs a JWT).
//
// Mounted at: /v1/public

const router  = require('express').Router();
const iCtrl   = require('../controllers/invite.controller');
const cCtrl   = require('../controllers/container.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const { inviteLimiter, publicLookupLimiter } = require('../middleware/rateLimiter');

// ── Invite preview (public) ───────────────────────────────────────
router.get('/invites/:token', publicLookupLimiter, iCtrl.previewInvite);

// ── Invite acceptance (authenticated) ────────────────────────────
router.post(
  '/invites/:token/accept',
  inviteLimiter,
  requireAuth,
  loadDbUser,
  iCtrl.acceptInvite
);

// ── Public container summary (public) ────────────────────────────
// Shared read-only view of a container. Privacy is controlled by
// containers.public_show_names — names are omitted if false.
router.get('/containers/:publicToken', publicLookupLimiter, cCtrl.getPublicContainer);

module.exports = router;
