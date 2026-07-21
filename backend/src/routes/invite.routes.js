// src/routes/invite.routes.js
const router = require('express').Router();
const ctrl = require('../controllers/invite.controller');
const { requireAuth } = require('../middleware/auth');
const { inviteLimiter, publicLookupLimiter } = require('../middleware/rateLimiter');

// Public — no auth required (tighter anti-enumeration limiter)
router.get('/:token/preview', publicLookupLimiter, ctrl.previewInvite);

// Authenticated
router.post('/:token/accept', inviteLimiter, requireAuth, ctrl.acceptInvite);

module.exports = router;
