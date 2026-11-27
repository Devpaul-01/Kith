const { z } = require('zod');

const TARGET_TOOL_NAME = 'select_target';
// Write tools that act on one existing record and are otherwise offered only
// when the client sends a matching selected_* field.
const TARGET_PURPOSES = Object.freeze([
  'update_task', 'admin_confirm_task', 'delete_contact', 'add_dispute_note', 'resolve_dispute',
  'raise_dispute', 'confirm_ledger_entry', 'create_ledger_entry',
]);
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;

// The model supplies only what the user said. It never supplies an ID.
const selectTargetArgsSchema = z.object({
  purpose: z.enum(TARGET_PURPOSES),
  query: z.string().trim().min(2).max(200)
    .refine((value) => !unsupportedText.test(value), 'Query contains unsupported characters').optional(),
}).strict();

const selectTargetDefinition = Object.freeze({
  name: TARGET_TOOL_NAME,
  tier: 0,
  minRole: 'member',
  description: 'Find the record the user wants to act on when the matching write tool is not offered. Set purpose to that write tool\'s name and query to the user\'s own words naming the record (a title, name or description); omit query if they gave no details. Never put an ID anywhere. The server searches, keeps only records the user may act on, and either selects the single clear match (the write tool is then offered: call it next), shows the user a list to choose from (their reply ends this turn), or reports needs_details, not_found or unavailable (then ask one short clarifying question, or explain missing permission). This tool never changes anything.',
  parameterSchema: selectTargetArgsSchema,
});

// What the client sends back, verbatim, as the named selected_* field.
const selectionPayloadSchema = z.union([z.string().uuid(), z.record(z.string().uuid())]);
const selectionRequestSchema = z.object({
  purpose: z.enum(TARGET_PURPOSES),
  selected_field: z.string().regex(/^selected_[a-z_]+$/),
  status: z.enum(['ambiguous', 'single_match', 'listing']),
  query: z.string().nullable(),
  candidates: z.array(z.object({
    selection: selectionPayloadSchema,
    title: z.string().min(1).max(200),
    subtitle: z.string().max(300).nullable(),
  }).strict()).min(1).max(5),
  has_more: z.boolean(),
}).strict();

module.exports = {
  TARGET_TOOL_NAME, TARGET_PURPOSES, selectTargetArgsSchema, selectTargetDefinition, selectionRequestSchema,
};
