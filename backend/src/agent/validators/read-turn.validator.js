const { z } = require('zod');
const { tokenUsageSchema } = require('./provider-metadata.validator');
const { taskTargetSchema } = require('./proposal.validator');

const READ_TURN_LIMITS = Object.freeze({
  modelCalls: 6,
  toolCalls: 12, // Includes the initial get_my_context read.
  messageChars: 8000,
  replyChars: 16000,
  argumentChars: 8000,
  toolResultBytes: 64 * 1024,
  conversationBytes: 128 * 1024,
});

// Only text comes from the client. Context and provider are server-owned.
const readTurnInputSchema = z.object({
  message: z.string().max(READ_TURN_LIMITS.messageChars).trim().min(1),
}).strict();

// Omit for a stateless turn; null starts a conversation; a UUID resumes it.
// The client never supplies the stored messages or the conversation's owner.
const chatInputSchema = readTurnInputSchema.extend({
  conversation_id: z.string().uuid().nullable().optional(),
  selected_notification_id: z.string().uuid().transform((id) => id.toLowerCase()).optional(),
  selected_contact_id: z.string().uuid().transform((id) => id.toLowerCase()).optional(),
  selected_task: taskTargetSchema.optional(),
  selected_container_id: z.string().uuid().transform((id) => id.toLowerCase()).optional(),
});

const providerToolCallSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  arguments: z.string().max(READ_TURN_LIMITS.argumentChars),
}).strict();

// The provider adapter normalizes its response into this contract.
const readProviderReplySchema = z.object({
  text: z.string().max(READ_TURN_LIMITS.replyChars).nullable().default(null),
  toolCalls: z.array(providerToolCallSchema).max(READ_TURN_LIMITS.toolCalls).default([]),
  usage: tokenUsageSchema.nullable().optional(),
}).strict().refine((reply) => reply.toolCalls.length > 0 || Boolean(reply.text?.trim()), {
  message: 'A provider reply must contain text or tool calls',
});

module.exports = { READ_TURN_LIMITS, readTurnInputSchema, chatInputSchema, readProviderReplySchema, providerToolCallSchema };
