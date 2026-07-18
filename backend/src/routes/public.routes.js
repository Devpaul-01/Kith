// src/routes/public.routes.js
//
// All routes in this file are publicly accessible — no auth required
// (except /invites/:token/accept which needs a JWT).
//
// Mounted at: /v1/public
//
// Routes:
//   GET  /v1/public/invites/:token           — preview an invite link (no auth)
//   POST /v1/public/invites/:token/accept    — accept an invite (auth required)
//   GET  /v1/public/containers/:publicToken  — view a shared container summary (no auth)

const router  = require('express').Router();
const iCtrl   = require('../controllers/invite.controller');
const cCtrl   = require('../controllers/container.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const { inviteLimiter, publicLookupLimiter } = require('../middleware/rateLimiter');

// ── Invite preview (public) ───────────────────────────────────────
// Shows workspace name, inviter, and active containers — no login needed.
// Used for the /invite/:token landing page.
//
// Audit finding 8.2: unauthenticated lookup endpoints had no rate limit
// of their own — only generalLimiter's loose 200/min IP-based baseline
// applied, which isn't tuned against token-space enumeration. Tightened
// with publicLookupLimiter (30/min per IP) specifically for this reason.
router.get('/invites/:token', publicLookupLimiter, iCtrl.previewInvite);

// ── Invite acceptance (authenticated) ────────────────────────────
// The user must be logged in (or just signed up) to accept an invite.
// After accepting they become a workspace member.
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
