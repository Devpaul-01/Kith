const { randomUUID } = require('crypto');
const { z } = require('zod');
const { getRedis } = require('../../config/redis');
const { TTL, agentBudgetKey } = require('../../config/redis-keys');
const { ForbiddenError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { assertAgentContext } = require('./context.service');
const { providerError } = require('../providers/provider-errors');
const { tokenUsageSchema } = require('../validators/provider-metadata.validator');
const { budgetConfigSchema, reservationSchema, reserveReplySchema, settleReplySchema } = require('../validators/budget.validator');
const { RESERVE_SCRIPT, SETTLE_SCRIPT } = require('./budget-scripts');

function budgetWindow(period, timestamp) {
  const date = new Date(timestamp);
  if (!Number.isSafeInteger(timestamp) || Number.isNaN(date.getTime())) {
    throw providerError('AGENT_BUDGET_UNAVAILABLE');
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = period === 'day' ? date.getUTCDate() : 1;
  return {
    windowStartMs: Date.UTC(year, month, day),
    resetAtMs: period === 'day' ? Date.UTC(year, month, day + 1) : Date.UTC(year, month + 1, 1),
  };
}

/** Workspace identity is captured from authenticated middleware, never model data. */
function createWorkspaceBudget({ context, limit, period, timeoutMs = 3000, redisFactory = getRedis, now = Date.now } = {}) {
  assertAgentContext(context);
  if (!z.string().uuid().safeParse(context.workspace.id).success) throw new ForbiddenError('Active workspace membership required');
  const parsed = budgetConfigSchema.safeParse({ limit, period, timeoutMs });
  if (!parsed.success || typeof redisFactory !== 'function' || typeof now !== 'function') {
    throw providerError('AGENT_BUDGET_CONFIGURATION');
  }
  const config = parsed.data;
  const workspaceId = context.workspace.id.toLowerCase();
  const actorUserId = context.userId;

  async function command(script, key, args) {
    let timer;
    try {
      const redis = redisFactory();
      // The shared BullMQ client retries indefinitely. Budget checks have their
      // own deadline and require a ready connection. An outage skips accounting
      // so the caller can continue chatting; it never invents a local balance.
      if (redis?.status !== 'ready' || typeof redis.eval !== 'function') throw providerError('AGENT_BUDGET_UNAVAILABLE');
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(providerError('AGENT_BUDGET_UNAVAILABLE')), config.timeoutMs);
      });
      return await Promise.race([redis.eval(script, 1, key, ...args), deadline]);
    } catch {
      logger.warn('Agent token budget unavailable; continuing without accounting', { workspaceId, actorUserId });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async reserve({ tokens } = {}) {
      if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 1000000000) throw new ValidationError('Invalid agent token reservation');
      const id = randomUUID();
      let window = budgetWindow(config.period, now());
      // Redis time detects clock skew or a reset while the command was queued.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const key = agentBudgetKey(workspaceId, config.period, window.windowStartMs);
        const raw = await command(RESERVE_SCRIPT, key, [
          window.windowStartMs, window.resetAtMs, config.limit, tokens, id,
          window.resetAtMs + TTL.AGENT_BUDGET_RETENTION_SECONDS * 1000,
        ]);
        if (raw === null) return null;
        const parsedReply = reserveReplySchema.safeParse(raw);
        if (!parsedReply.success) throw providerError('AGENT_BUDGET_UNAVAILABLE');
        const [state, value] = parsedReply.data;
        if (state === 'stale') {
          window = budgetWindow(config.period, value);
          continue;
        }
        if (state === 'reserved') {
          return Object.freeze({ id, workspaceId, period: config.period, ...window, reservedTokens: tokens });
        }
        if (state === 'too_large') throw providerError('AGENT_BUDGET_REQUEST_TOO_LARGE');
        if (state === 'exhausted' || state === 'blocked') {
          logger.info('Agent workspace token allowance exhausted', { workspaceId, actorUserId, resetAtMs: window.resetAtMs });
          throw providerError('AGENT_BUDGET_EXHAUSTED', undefined, window.resetAtMs);
        }
        throw providerError('AGENT_BUDGET_UNAVAILABLE');
      }
      throw providerError('AGENT_BUDGET_UNAVAILABLE');
    },

    async settle({ reservation, usage = null } = {}) {
      // A null reservation means Redis was unavailable before the model call.
      // Do not create a new reservation after the call or imply it was charged.
      if (reservation === null) return { state: 'unavailable' };
      const parsedReservation = reservationSchema.safeParse(reservation);
      if (!parsedReservation.success) throw new ValidationError('Invalid agent token reservation');
      const ticket = parsedReservation.data;
      if (ticket.workspaceId !== workspaceId) throw new ForbiddenError('The reservation belongs to another workspace');
      const expectedWindow = budgetWindow(ticket.period, ticket.windowStartMs);
      if (ticket.windowStartMs !== expectedWindow.windowStartMs || ticket.resetAtMs !== expectedWindow.resetAtMs) {
        throw new ValidationError('Invalid agent budget window');
      }
      const parsedUsage = tokenUsageSchema.nullable().safeParse(usage);
      if (!parsedUsage.success) throw new ValidationError('Invalid agent token usage');
      const key = agentBudgetKey(workspaceId, ticket.period, ticket.windowStartMs);
      const raw = await command(SETTLE_SCRIPT, key, [ticket.id, parsedUsage.data ? String(parsedUsage.data.totalTokens) : '']);
      if (raw === null) return { state: 'unavailable' };
      const parsedReply = settleReplySchema.safeParse(raw);
      if (!parsedReply.success || !['settled', 'held'].includes(parsedReply.data[0])) throw providerError('AGENT_BUDGET_UNAVAILABLE');
      const [state, usedTokens, chargedTokens] = parsedReply.data;
      logger.info('Agent token reservation reconciled', { workspaceId, actorUserId, reservationId: ticket.id, state, usedTokens, chargedTokens });
      return { state, usedTokens, chargedTokens };
    },
  });
}

module.exports = { createWorkspaceBudget };
