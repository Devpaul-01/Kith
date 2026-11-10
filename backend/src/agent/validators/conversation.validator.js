const { z } = require('zod');
const { READ_TURN_LIMITS, providerToolCallSchema } = require('./read-turn.validator');
const { proposalSchema } = require('./proposal.validator');

const CONVERSATION_LIMITS = Object.freeze({
  turns: 8,
  recordBytes: READ_TURN_LIMITS.conversationBytes + 4096,
  redisTimeoutMs: 1000,
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string().min(1).max(READ_TURN_LIMITS.messageChars).refine((value) => Boolean(value.trim())),
}).strict();
const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().min(1).max(READ_TURN_LIMITS.replyChars).refine((value) => Boolean(value.trim())),
}).strict();
const assistantCallsSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().max(READ_TURN_LIMITS.replyChars).nullable(),
  tool_calls: z.array(z.object({
    id: providerToolCallSchema.shape.id,
    type: z.literal('function'),
    function: z.object({
      name: providerToolCallSchema.shape.name,
      arguments: providerToolCallSchema.shape.arguments,
    }).strict(),
  }).strict()).min(1).max(READ_TURN_LIMITS.toolCalls),
}).strict();
const toolMessageSchema = z.object({
  role: z.literal('tool'),
  tool_call_id: providerToolCallSchema.shape.id,
  content: z.string().max(READ_TURN_LIMITS.toolResultBytes).refine((value) => {
    if (Buffer.byteLength(value, 'utf8') > READ_TURN_LIMITS.toolResultBytes) return false;
    try {
      const envelope = JSON.parse(value);
      return envelope?.kind === 'untrusted_tool_result' && Object.hasOwn(envelope, 'data')
        && Object.keys(envelope).length === 2;
    } catch { return false; }
  }, 'Invalid tool result envelope'),
}).strict();

// Store only completed turns. Incomplete calls and system/developer messages
// can never be restored into a later request, even from a corrupt Redis record.
const turnSchema = z.array(z.union([
  userMessageSchema, assistantMessageSchema, assistantCallsSchema, toolMessageSchema,
])).min(4).max(2 + READ_TURN_LIMITS.toolCalls * 2).refine((messages) => {
  if (messages[0]?.role !== 'user' || messages.at(-1)?.role !== 'assistant' || messages.at(-1).tool_calls) return false;
  const ids = new Set();
  let index = 1;
  while (index < messages.length - 1) {
    const message = messages[index++];
    if (message.role !== 'assistant' || !message.tool_calls) return false;
    for (const call of message.tool_calls) {
      if (ids.has(call.id)) return false;
      ids.add(call.id);
      const result = messages[index++];
      if (result?.role !== 'tool' || result.tool_call_id !== call.id) return false;
    }
  }
  return index === messages.length - 1 && ids.size <= READ_TURN_LIMITS.toolCalls;
}, 'Invalid completed conversation turn');

const historySchema = z.array(turnSchema).max(CONVERSATION_LIMITS.turns)
  .refine((turns) => Buffer.byteLength(JSON.stringify(turns), 'utf8') <= READ_TURN_LIMITS.conversationBytes,
    'Conversation history is too large');
const conversationRecordSchema = z.object({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  turns: historySchema,
}).strict();
const conversationResultSchema = z.object({
  reply: z.object({
    text: assistantMessageSchema.shape.content,
    modelCalls: z.number().int().min(1).max(READ_TURN_LIMITS.modelCalls),
    toolCalls: z.number().int().min(1).max(READ_TURN_LIMITS.toolCalls),
    proposal: proposalSchema.optional(),
  }).strict(),
  history: historySchema,
}).strict().refine(({ reply, history }) => history.length > 0 && history.at(-1)?.at(-1)?.content === reply.text,
  'Conversation reply does not match its history');

const acquireReplySchema = z.union([
  z.tuple([z.literal('ready'), z.string().max(CONVERSATION_LIMITS.recordBytes)]),
  z.tuple([z.enum(['missing', 'busy', 'exists'])]),
]);
const commitReplySchema = z.tuple([z.enum(['saved', 'missing', 'lost'])]);

module.exports = {
  CONVERSATION_LIMITS, historySchema, conversationRecordSchema, conversationResultSchema,
  acquireReplySchema, commitReplySchema,
};
