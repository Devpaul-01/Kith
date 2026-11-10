const { createHash, randomUUID } = require('crypto');
const { z } = require('zod');
const { getRedis } = require('../../config/redis');
const { agentConversationKey, TTL } = require('../../config/redis-keys');
const { AppError, ValidationError } = require('../../utils/errors');
const { withRedisDeadline } = require('../../utils/redis-deadline');
const logger = require('../../utils/logger');
const { assertNotCancelled } = require('../utils/cancellation');
const { assertAgentContext } = require('./context.service');
const {
  CONVERSATION_LIMITS, conversationRecordSchema, conversationResultSchema,
  acquireReplySchema, commitReplySchema,
} = require('../validators/conversation.validator');
const { ACQUIRE_CONVERSATION_SCRIPT, COMMIT_CONVERSATION_SCRIPT, RELEASE_CONVERSATION_SCRIPT } = require('./conversation-scripts');

const unavailable = () => new AppError('Conversation history is unavailable. Please try again.', 503, 'AGENT_CONVERSATION_UNAVAILABLE');
const missing = () => new AppError('Conversation not found or expired. Start a new conversation.', 404, 'AGENT_CONVERSATION_NOT_FOUND');

/** Serialize a conversation turn using only authenticated, server-owned state. */
async function runConversationTurn({ context, conversationId, runTurn, redisFactory = getRedis, signal } = {}) {
  assertAgentContext(context);
  assertNotCancelled(signal);
  const input = z.string().uuid().nullable().safeParse(conversationId);
  if (!input.success) throw new ValidationError('Invalid conversation ID');
  if (typeof runTurn !== 'function' || typeof redisFactory !== 'function') throw unavailable();

  const mode = input.data === null ? 'create' : 'resume';
  const id = input.data === null ? randomUUID() : input.data.toLowerCase();
  const scope = createHash('sha256').update(JSON.stringify([
    context.userId, context.member.id, context.workspace.id, context.member.role,
  ])).digest('hex');
  const trace = {
    requestId: context.requestId, conversationId: id, workspaceId: context.workspace.id,
    actorUserId: context.userId, actorMemberId: context.member.id,
  };
  const key = agentConversationKey(scope, id);
  const token = randomUUID();
  let redis;
  let acquired = false;
  let committed = false;

  async function command(script, args) {
    try {
      return await withRedisDeadline(redis, () => redis.eval(script, 2, key, `${key}:lease`, ...args), CONVERSATION_LIMITS.redisTimeoutMs);
    } catch { throw unavailable(); }
  }

  try {
    try { redis = redisFactory(); } catch { throw unavailable(); }
    const raw = await command(ACQUIRE_CONVERSATION_SCRIPT, [
      mode, token, JSON.stringify({ version: 1, scope, turns: [] }),
      TTL.AGENT_CONVERSATION_SECONDS, TTL.AGENT_CONVERSATION_LEASE_SECONDS * 1000,
    ]);
    // A malformed/oversized payload must still release this request's lease.
    acquired = Array.isArray(raw) && raw[0] === 'ready';
    const admission = acquireReplySchema.safeParse(raw);
    if (!admission.success) throw unavailable();
    const [state, payload] = admission.data;
    if (state === 'missing') throw missing();
    if (state === 'busy') {
      throw new AppError('A reply is already in progress for this conversation. Please wait.', 409, 'AGENT_CONVERSATION_BUSY');
    }
    if (state !== 'ready') throw unavailable();
    if (Buffer.byteLength(payload, 'utf8') > CONVERSATION_LIMITS.recordBytes) throw unavailable();
    let record;
    try { record = conversationRecordSchema.parse(JSON.parse(payload)); } catch { throw unavailable(); }
    if (record.scope !== scope) throw missing();

    assertNotCancelled(signal);
    const output = conversationResultSchema.safeParse(await runTurn({ history: record.turns }));
    assertNotCancelled(signal);
    if (!output.success) throw unavailable();
    const next = JSON.stringify({ version: 1, scope, turns: output.data.history });
    if (Buffer.byteLength(next, 'utf8') > CONVERSATION_LIMITS.recordBytes) throw unavailable();
    const saved = commitReplySchema.safeParse(await command(COMMIT_CONVERSATION_SCRIPT, [token, next, TTL.AGENT_CONVERSATION_SECONDS]));
    if (!saved.success) throw unavailable();
    if (saved.data[0] !== 'saved') {
      throw new AppError('This conversation changed or expired. Please retry or start a new conversation.', 409, 'AGENT_CONVERSATION_CONFLICT');
    }
    committed = true;
    logger.info('Agent conversation turn saved', trace);
    return { ...output.data.reply, conversation_id: id };
  } catch (err) {
    logger.warn('Agent conversation turn failed', { ...trace, errorCode: err.code });
    throw err;
  } finally {
    if (acquired && !committed) {
      try { await command(RELEASE_CONVERSATION_SCRIPT, [token, mode]); } catch {
        // Do not hide the original failure. Redis expiry bounds abandoned leases.
        logger.warn('Agent conversation lease release unavailable', trace);
      }
    }
  }
}

module.exports = { runConversationTurn };
