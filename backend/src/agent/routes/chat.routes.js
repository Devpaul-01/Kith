// Mounted only inside workspace.routes, after auth and active membership.
const router = require('express').Router({ mergeParams: true });
const { agentLimiter } = require('../../middleware/rateLimiter');
const { chat } = require('../controllers/chat.controller');
const { approve, reject } = require('../controllers/proposal.controller');

router.post('/chat', agentLimiter, chat);
router.post('/proposals/:proposalId/approve', agentLimiter, approve);
router.post('/proposals/:proposalId/reject', agentLimiter, reject);

module.exports = router;
