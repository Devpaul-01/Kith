const { success } = require('../../utils/response');
const { chatInputSchema } = require('../validators/read-turn.validator');
const { runChatTurn } = require('../services/chat.service');
const { AppError } = require('../../utils/errors');
const { writeEvent } = require('../utils/event-stream');
const logger = require('../../utils/logger');
const audit = require('../../services/audit.service');

function retryAfter(err) {
  return err.code === 'AGENT_BUDGET_EXHAUSTED' && Number.isSafeInteger(err.resetAtMs)
    ? Math.max(1, Math.ceil((err.resetAtMs - Date.now()) / 1000)) : undefined;
}

async function chat(req, res, next) {
  // Only an explicit Accept entry opts in; */* retains the JSON contract.
  const streaming = req.get('accept')?.split(',').some((value) => value.split(';')[0].trim().toLowerCase() === 'text/event-stream')
    && req.accepts(['application/json', 'text/event-stream']) === 'text/event-stream';
  const controller = new AbortController();
  const closed = () => { if (!res.writableEnded) controller.abort(); };
  if (streaming) res.on('close', closed);
  async function emit(event) {
    if (!res.headersSent) {
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    }
    await writeEvent(res, event, controller.signal);
  }
  try {
    res.vary('Accept');
    const data = chatInputSchema.parse(req.body);
    const result = await runChatTurn({
      data,
      context: { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId },
      actorCtx: audit.fromReq(req),
      ...(streaming ? { onEvent: emit, signal: controller.signal } : {}),
    });
    if (streaming) {
      await emit({ type: 'done', data: { data: result } });
      res.end();
      return;
    }
    res.set('Cache-Control', 'no-store');
    success(res, result);
  } catch (err) {
    if (streaming && (controller.signal.aborted || res.destroyed || err.code === 'AGENT_REQUEST_CANCELLED')) {
      res.destroy();
      return;
    }
    const retry = retryAfter(err);
    if (streaming && res.headersSent) {
      // Headers are already committed. Send a terminal, sanitized error and
      // never fall through to the JSON error middleware or publish a done event.
      const error = err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL_ERROR', message: 'The agent request could not be completed.' };
      logger.warn('Agent stream failed', { requestId: req.requestId, errorCode: error.code });
      try {
        await emit({ type: 'error', data: { error, ...(retry ? { retry_after: retry } : {}) } });
        res.end();
      } catch { res.destroy(); }
      return;
    }
    if (retry) res.set('Retry-After', String(retry));
    next(err);
  } finally {
    res.removeListener('close', closed);
  }
}

module.exports = { chat };
