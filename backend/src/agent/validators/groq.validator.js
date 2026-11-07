const { z } = require('zod');
const { READ_TURN_LIMITS, providerToolCallSchema } = require('./read-turn.validator');

const GROQ_LIMITS = Object.freeze({
  requestBytes: 256 * 1024,
  responseBytes: 256 * 1024,
  tools: 128,
  messages: 64,
});

const groqConfigSchema = z.object({
  apiKey: z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/),
  model: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
    // Compound systems can execute provider-hosted tools outside Kith.
    .refine((model) => !model.toLowerCase().split('/').some((part) => part.startsWith('compound'))),
  timeoutMs: z.coerce.number().int().min(1).max(60000),
  maxCompletionTokens: z.coerce.number().int().min(1).max(4096),
}).strict();

const toolDefinitionsSchema = z.array(z.object({
  name: providerToolCallSchema.shape.name,
  description: z.string().min(1).max(4096),
  parameterSchema: z.instanceof(z.ZodType),
}).strict()).max(GROQ_LIMITS.tools).refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, {
  message: 'Tool names must be unique',
});

const wireToolCallSchema = z.object({
  id: providerToolCallSchema.shape.id,
  type: z.literal('function'),
  function: z.object({
    name: providerToolCallSchema.shape.name,
    arguments: providerToolCallSchema.shape.arguments,
  }).strict(),
}).strict();

const content = z.string().max(READ_TURN_LIMITS.conversationBytes);
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: content.min(1) }).strict(),
  z.object({ role: z.literal('user'), content: content.min(1) }).strict(),
  z.object({
    role: z.literal('assistant'), content: content.nullable(),
    tool_calls: z.array(wireToolCallSchema).max(READ_TURN_LIMITS.toolCalls).optional(),
  }).strict(),
  z.object({ role: z.literal('tool'), content: content.min(1), tool_call_id: providerToolCallSchema.shape.id }).strict(),
]);

const groqRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(GROQ_LIMITS.messages),
  tools: toolDefinitionsSchema.default([]),
}).strict();

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const groqResponseSchema = z.object({
  choices: z.array(z.object({
    index: z.literal(0),
    finish_reason: z.enum(['stop', 'tool_calls', 'length']),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().max(READ_TURN_LIMITS.replyChars).nullish(),
      refusal: z.string().max(READ_TURN_LIMITS.replyChars).nullish(),
      tool_calls: z.array(wireToolCallSchema).max(READ_TURN_LIMITS.toolCalls).nullish(),
      // Deprecated or provider-executed tools are not part of this adapter.
      function_call: z.null().optional(),
      executed_tools: z.array(z.unknown()).max(0).nullish(),
    }),
  })).length(1),
  usage: z.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount, total_tokens: tokenCount }).nullish(),
});

module.exports = { GROQ_LIMITS, groqConfigSchema, toolDefinitionsSchema, groqRequestSchema, groqResponseSchema };
