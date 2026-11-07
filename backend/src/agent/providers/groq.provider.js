const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { GROQ_LIMITS, groqConfigSchema, groqRequestSchema, groqResponseSchema } = require('../validators/groq.validator');
const { readProviderReplySchema } = require('../validators/read-turn.validator');
const { serializeToolDefinitions } = require('./tool-definitions');
const { providerError, normalizeProviderError } = require('./provider-errors');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function readResponseJson(response) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const declaredSize = Number(response.headers.get('content-length'));
  if (contentType !== 'application/json' || declaredSize > GROQ_LIMITS.responseBytes || !response.body) {
    throw providerError('AGENT_INVALID_RESPONSE');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > GROQ_LIMITS.responseBytes) throw providerError('AGENT_INVALID_RESPONSE');
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw providerError('AGENT_INVALID_RESPONSE');
  }
}

function normalizeReply(payload, allowedNames) {
  const parsed = groqResponseSchema.safeParse(payload);
  if (!parsed.success) throw providerError('AGENT_INVALID_RESPONSE');
  const choice = parsed.data.choices[0];
  if (choice.finish_reason === 'length') throw providerError('AGENT_RESPONSE_TRUNCATED');

  const calls = choice.message.tool_calls || [];
  const hasCalls = calls.length > 0;
  if ((choice.finish_reason === 'tool_calls') !== hasCalls || (hasCalls && choice.message.refusal)) {
    throw providerError('AGENT_INVALID_RESPONSE');
  }
  if (new Set(calls.map((call) => call.id)).size !== calls.length
      || calls.some((call) => !allowedNames.has(call.function.name))) {
    throw providerError('AGENT_INVALID_RESPONSE');
  }
  const reply = readProviderReplySchema.safeParse({
    text: choice.message.refusal || choice.message.content || null,
    toolCalls: calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
  });
  if (!reply.success) throw providerError('AGENT_INVALID_RESPONSE');
  return { reply: reply.data, usage: parsed.data.usage };
}

/**
 * Server-only factory. The model and credentials never come from chat data.
 * fetchImpl is injectable for tests; the production endpoint is fixed.
 */
function createGroqProvider({
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL,
  timeoutMs = process.env.GROQ_TIMEOUT_MS ?? 20000,
  maxCompletionTokens = process.env.GROQ_MAX_COMPLETION_TOKENS ?? 1024,
  fetchImpl = globalThis.fetch,
} = {}) {
  const parsed = groqConfigSchema.safeParse({ apiKey, model, timeoutMs, maxCompletionTokens });
  if (!parsed.success || typeof fetchImpl !== 'function') throw providerError('AGENT_PROVIDER_CONFIGURATION');
  const config = parsed.data;

  return Object.freeze({
    async chat(request) {
      const input = groqRequestSchema.safeParse(request);
      if (!input.success) throw new ValidationError('Invalid provider request');
      const definitions = serializeToolDefinitions(input.data.tools);
      const body = JSON.stringify({
        model: config.model,
        messages: input.data.messages,
        ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
        disable_tool_validation: false,
        stream: false,
        n: 1,
        temperature: 0,
        max_completion_tokens: config.maxCompletionTokens,
      });
      if (Buffer.byteLength(body, 'utf8') > GROQ_LIMITS.requestBytes) throw providerError('AGENT_CONTEXT_LIMIT');

      const startedAt = Date.now();
      const controller = new AbortController();
      const trace = { provider: 'groq', model: config.model };
      let response;
      let timer;
      let timedOut = false;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(providerError('AGENT_PROVIDER_TIMEOUT'));
          controller.abort();
        }, config.timeoutMs);
      });

      try {
        const operation = (async () => {
          response = await fetchImpl(GROQ_CHAT_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
            redirect: 'error',
          });
          trace.httpStatus = response.status;
          if (response.status === 429) throw providerError('AGENT_PROVIDER_RATE_LIMITED');
          if (!response.ok) throw providerError('AGENT_PROVIDER_UNAVAILABLE');
          const payload = await readResponseJson(response);
          return normalizeReply(payload, new Set(input.data.tools.map((tool) => tool.name)));
        })();
        const { reply, usage } = await Promise.race([operation, deadline]);
        logger.info('Groq chat completed', { ...trace, usage, durationMs: Date.now() - startedAt });
        return reply;
      } catch (err) {
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        const error = timedOut ? providerError('AGENT_PROVIDER_TIMEOUT') : normalizeProviderError(err);
        logger.warn('Groq chat failed', { ...trace, errorCode: error.code, durationMs: Date.now() - startedAt });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

module.exports = { createGroqProvider };
