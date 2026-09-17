// src/routes/public.routes.js
//
// All routes in this file are publicly accessible — no auth required
// (except /invites/:token/accept which needs a JWT).
//
// Mounted at: /v1/public

const router  = require('express').Router();
const iCtrl   = require('../controllers/invite.controller');
const cCtrl   = require('../controllers/container.controller');
const { supabase } = require('../config/supabase'); // adjust path to your actual client module
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
// routes/public.routes.js (add to existing router)
router.post('/track-visit', async (req, res) => {
  try {
    const ip = req.ip; // trust proxy is already set, so this is the real client IP
    const userAgent = req.headers['user-agent'] || null;

    const { error } = await supabase.rpc('upsert_visit', {
      p_ip: ip,
      p_user_agent: userAgent,
    });

    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: { code: 'TRACK_FAILED', message: err.message } });
  }
});
// ── Public container summary (public) ────────────────────────────
// Shared read-only view of a container. Privacy is controlled by
// containers.public_show_names — names are omitted if false.
router.get('/containers/:publicToken', publicLookupLimiter, cCtrl.getPublicContainer);

module.exports = router;
