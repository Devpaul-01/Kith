const { assertAgentContext } = require('./context.service');
const { ValidationError } = require('../../utils/errors');
const { chatInputSchema } = require('../validators/read-turn.validator');
const { runReadTurn, runReadTurnWithHistory } = require('./read-loop.service');
const { runConversationTurn } = require('./conversation.service');
const { createGroqProvider } = require('../providers/groq.provider');
const { createWorkspaceBudget } = require('./budget.service');

/** Compose the read loop with server-owned provider configuration per turn. */
async function runChatTurn({ data, context } = {}) {
  assertAgentContext(context);
  const input = chatInputSchema.safeParse(data);
  if (!input.success) throw new ValidationError('Invalid agent message', null, input.error.issues);
  // Freeze identity before awaiting Redis, not only when the model loop starts.
  const actorContext = Object.freeze({
    userId: context.userId, requestId: context.requestId,
    member: Object.freeze({ ...context.member }), workspace: Object.freeze({ ...context.workspace }),
  });
  // Initialize lazily: an unconfigured provider must not prevent API startup.
  const budget = createWorkspaceBudget({
    context: actorContext,
    limit: process.env.AGENT_WORKSPACE_TOKEN_LIMIT ?? 100000,
    period: process.env.AGENT_BUDGET_PERIOD ?? 'day',
    timeoutMs: process.env.AGENT_BUDGET_TIMEOUT_MS ?? 3000,
  });
  const provider = createGroqProvider({ budget });
  const turnData = { message: input.data.message };
  if (input.data.conversation_id === undefined) {
    return runReadTurn({ data: turnData, context: actorContext, provider });
  }
  return runConversationTurn({
    context: actorContext, conversationId: input.data.conversation_id,
    runTurn: ({ history }) => runReadTurnWithHistory({ data: turnData, context: actorContext, provider, history }),
  });
}

module.exports = { runChatTurn };
