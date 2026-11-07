const { z } = require('zod');

const budgetPeriodSchema = z.enum(['day', 'month']);
const budgetLimitSchema = z.coerce.number().int().min(1).max(1000000000);
const budgetConfigSchema = z.object({
  limit: budgetLimitSchema,
  period: budgetPeriodSchema,
  timeoutMs: z.coerce.number().int().min(1).max(10000),
}).strict();

const count = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.coerce.number().int().nonnegative().max(8640000000000000);
const reservationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  period: budgetPeriodSchema,
  windowStartMs: timestamp,
  resetAtMs: timestamp,
  reservedTokens: z.number().int().min(0).max(1000000000),
}).strict();

const reserveReplySchema = z.union([
  z.tuple([z.literal('reserved'), count, budgetLimitSchema]),
  z.tuple([z.literal('stale'), timestamp]),
  z.tuple([z.enum(['exhausted', 'too_large', 'invalid', 'settled', 'blocked'])]),
]);
const settleReplySchema = z.union([
  z.tuple([z.enum(['settled', 'held']), count, count]),
  z.tuple([z.enum(['missing', 'invalid', 'blocked'])]),
]);

module.exports = { budgetConfigSchema, reservationSchema, reserveReplySchema, settleReplySchema };
