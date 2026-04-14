// src/routes/invite.routes.js
const router = require('express').Router();
const ctrl = require('../controllers/invite.controller');
const { requireAuth } = require('../middleware/auth');
const { inviteLimiter } = require('../middleware/rateLimiter');

// Public — no auth required
router.get('/:token/preview', ctrl.previewInvite);

// Authenticated
router.post('/:token/accept', inviteLimiter, requireAuth, ctrl.acceptInvite);

module.exports = router;
