const { z } = require('zod');

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenUsageSchema = z.object({
  promptTokens: tokenCount,
  completionTokens: tokenCount,
  totalTokens: tokenCount,
}).strict().refine((usage) => Number.isSafeInteger(usage.promptTokens + usage.completionTokens)
  && usage.totalTokens === usage.promptTokens + usage.completionTokens, {
  message: 'Token usage must contain consistent totals',
});

const traceId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
// Server metadata only; the adapter must never serialize it into a model request.
const providerTraceSchema = z.object({
  requestId: traceId.optional(),
  turnId: traceId,
  workspaceId: traceId,
  actorUserId: traceId,
  actorMemberId: traceId,
  modelCall: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

module.exports = { tokenCount, tokenUsageSchema, providerTraceSchema };
