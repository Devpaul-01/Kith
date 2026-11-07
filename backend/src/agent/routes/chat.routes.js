// Mounted only inside workspace.routes, after auth and active membership.
const router = require('express').Router({ mergeParams: true });
const { agentLimiter } = require('../../middleware/rateLimiter');
const { chat } = require('../controllers/chat.controller');

router.post('/chat', agentLimiter, chat);

module.exports = router;
