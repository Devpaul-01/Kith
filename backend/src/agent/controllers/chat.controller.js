const { success } = require('../../utils/response');
const { chatInputSchema } = require('../validators/read-turn.validator');
const { runChatTurn } = require('../services/chat.service');

async function chat(req, res, next) {
  try {
    const data = chatInputSchema.parse(req.body);
    const result = await runChatTurn({
      data,
      context: { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId },
    });
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) {
    if (err.code === 'AGENT_BUDGET_EXHAUSTED' && Number.isSafeInteger(err.resetAtMs)) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((err.resetAtMs - Date.now()) / 1000))));
    }
    next(err);
  }
}

module.exports = { chat };
