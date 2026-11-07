const { assertAgentContext } = require('./context.service');
const { runReadTurn } = require('./read-loop.service');
const { createGroqProvider } = require('../providers/groq.provider');
const { createWorkspaceBudget } = require('./budget.service');

/** Compose the read loop with server-owned provider configuration per turn. */
async function runChatTurn({ data, context } = {}) {
  assertAgentContext(context);
  // Initialize lazily: an unconfigured provider must not prevent API startup.
  const budget = createWorkspaceBudget({
    context,
    limit: process.env.AGENT_WORKSPACE_TOKEN_LIMIT ?? 100000,
    period: process.env.AGENT_BUDGET_PERIOD ?? 'day',
    timeoutMs: process.env.AGENT_BUDGET_TIMEOUT_MS ?? 3000,
  });
  return runReadTurn({ data, context, provider: createGroqProvider({ budget }) });
}

module.exports = { runChatTurn };
