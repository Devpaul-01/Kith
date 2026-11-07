const { success } = require('../../utils/response');
const { readTurnInputSchema } = require('../validators/read-turn.validator');
const { runChatTurn } = require('../services/chat.service');

async function chat(req, res, next) {
  try {
    const data = readTurnInputSchema.parse(req.body);
    const result = await runChatTurn({
      data,
      context: { userId: req.user.id, member: req.member, workspace: req.workspace },
    });
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) { next(err); }
}

module.exports = { chat };
