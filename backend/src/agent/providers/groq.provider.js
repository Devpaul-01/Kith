const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { GROQ_LIMITS, groqConfigSchema, groqRequestSchema, groqResponseSchema, groqUsageSchema } = require('../validators/groq.validator');
const { readProviderReplySchema } = require('../validators/read-turn.validator');
const { serializeToolDefinitions } = require('./tool-definitions');
const { providerError, normalizeProviderError } = require('./provider-errors');
const { readStreamReply } = require('./groq-stream');
const { assertNotCancelled } = require('../utils/cancellation');

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

function normalizeReply(payload, allowedNames, usage) {
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
    usage,
  });
  if (!reply.success) throw providerError('AGENT_INVALID_RESPONSE');
  return reply.data;
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
  budget,
} = {}) {
  const parsed = groqConfigSchema.safeParse({ apiKey, model, timeoutMs, maxCompletionTokens });
  if (!parsed.success || typeof fetchImpl !== 'function') throw providerError('AGENT_PROVIDER_CONFIGURATION');
  if (budget !== undefined && (typeof budget?.reserve !== 'function' || typeof budget?.settle !== 'function')) {
    throw providerError('AGENT_BUDGET_CONFIGURATION');
  }
  const config = parsed.data;

  return Object.freeze({
    async chat(request, { onText, signal } = {}) {
      const input = groqRequestSchema.safeParse(request);
      if (!input.success) throw new ValidationError('Invalid provider request');
      if ((onText !== undefined && typeof onText !== 'function')
          || (signal !== undefined && !(signal instanceof AbortSignal))) throw new ValidationError('Invalid provider controls');
      assertNotCancelled(signal);
      const definitions = serializeToolDefinitions(input.data.tools);
      const body = JSON.stringify({
        model: config.model,
        messages: input.data.messages,
        ...(definitions.length ? { tools: definitions, tool_choice: 'auto' } : {}),
        disable_tool_validation: false,
        stream: Boolean(onText),
        n: 1,
        temperature: 0,
        max_completion_tokens: config.maxCompletionTokens,
      });
      if (Buffer.byteLength(body, 'utf8') > GROQ_LIMITS.requestBytes) throw providerError('AGENT_CONTEXT_LIMIT');

      const startedAt = Date.now();
      const controller = new AbortController();
      const trace = { ...input.data.trace, provider: 'groq', model: config.model };
      // A byte-based allowance is conservative, not a model-specific tokenizer.
      // Include all serialized messages/tool definitions and the output cap.
      const reservation = budget ? await budget.reserve({ tokens: Buffer.byteLength(body, 'utf8') + config.maxCompletionTokens }) : null;
      if (budget) logger.info('Agent budget reservation checked', { ...trace, reservationId: reservation?.id, accountingAvailable: reservation !== null });
      let response;
      let usage = null;
      let timer;
      let timedOut = false;
      let cancel;
      const cancelled = new Promise((resolve, reject) => {
        cancel = () => {
          controller.abort();
          reject(providerError('AGENT_REQUEST_CANCELLED'));
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      });
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(providerError('AGENT_PROVIDER_TIMEOUT'));
          controller.abort();
        }, config.timeoutMs);
      });

      try {
        const operation = (async () => {
          assertNotCancelled(signal);
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
          assertNotCancelled(controller.signal);
          let payload;
          if (onText) {
            payload = await readStreamReply(response, {
              signal: controller.signal, onText,
              onUsage: (value) => { usage = value; },
            });
          } else {
            payload = await readResponseJson(response);
            const parsedUsage = groqUsageSchema.safeParse(payload?.usage);
            if (!parsedUsage.success) throw providerError('AGENT_INVALID_RESPONSE');
            usage = parsedUsage.data ?? null;
          }
          return normalizeReply(payload, new Set(input.data.tools.map((tool) => tool.name)), usage);
        })();
        const reply = await Promise.race([operation, deadline, cancelled]);
        logger.info('Groq chat completed', { ...trace, usage, durationMs: Date.now() - startedAt });
        return reply;
      } catch (err) {
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        const normalized = normalizeProviderError(err);
        const error = providerError(timedOut ? 'AGENT_PROVIDER_TIMEOUT' : normalized.code, usage || normalized.usage);
        logger.warn('Groq chat failed', { ...trace, usage: error.usage ?? null, errorCode: error.code, durationMs: Date.now() - startedAt });
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (budget) {
          try {
            await budget.settle({ reservation, usage });
          } catch {
            // An accounting failure must not discard a completed answer or mask
            // the original provider error. The stored reservation remains held.
            logger.warn('Agent budget reconciliation failed', { ...trace, reservationId: reservation?.id });
          }
        }
      }
    },
  });
}

module.exports = { createGroqProvider };
