const { assertAgentContext } = require('./context.service');
const { runReadTurn } = require('./read-loop.service');
const { createGroqProvider } = require('../providers/groq.provider');

/** Compose the read loop with server-owned provider configuration per turn. */
async function runChatTurn({ data, context } = {}) {
  assertAgentContext(context);
  // Initialize lazily: an unconfigured provider must not prevent API startup.
  return runReadTurn({ data, context, provider: createGroqProvider() });
}

module.exports = { runChatTurn };
