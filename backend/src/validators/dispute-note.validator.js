const { z } = require('zod');
const { addDisputeNoteSchema, createDisputeSchema } = require('./ledger.validator');

const timestamp = z.string().datetime({ offset: true });
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const uuid = z.string().uuid();

// The note is trimmed server-side, so the reviewed RPC can require pre-trimmed text.
const disputeNoteDataSchema = z.object({
  note: addDisputeNoteSchema.shape.note.trim().min(1)
    .refine((value) => !unsupportedText.test(value), 'Note contains unsupported characters'),
}).strict();
const disputeNoteTargetSchema = z.object({
  dispute_id: uuid.transform((id) => id.toLowerCase()),
}).strict();
const disputeNoteCallerSchema = z.object({
  workspaceId: uuid, disputeId: uuid, callerId: uuid, userId: uuid,
}).strict();

// Only immutable dispute identity is bound. Existing notes are deliberately
// outside the approval so concurrent notes are preserved, not treated as stale.
const noteDisputeStateSchema = z.object({
  dispute_id: uuid, ledger_entry_id: uuid, raised_by: uuid,
  reason: createDisputeSchema.shape.reason, status: z.literal('open'), raised_at: timestamp,
}).strict();
const disputeNoteContextSchema = z.object({
  workspace_id: uuid, actor_member_id: uuid, member_role: z.enum(['member', 'admin']),
  dispute: noteDisputeStateSchema,
}).strict();
const appendedNoteSchema = z.object({
  author_id: uuid, note: disputeNoteDataSchema.shape.note, added_at: timestamp,
}).strict();
const disputeNoteResultSchema = z.object({ dispute_id: uuid, note: appendedNoteSchema }).strict();
const disputeNoteRowSchema = z.object({
  id: uuid, workspace_id: uuid, status: z.literal('open'), notes: z.array(z.unknown()).min(1),
}).passthrough();
const disputeNoteReadRowSchema = noteDisputeStateSchema.omit({ dispute_id: true, status: true })
  .extend({ id: uuid, workspace_id: uuid, status: z.enum(['open', 'resolved']) }).strip();

function noteContextMatches(selection) {
  const { dispute } = selection;
  return selection.member_role === 'admin' || dispute.raised_by === selection.actor_member_id;
}

module.exports = {
  disputeNoteDataSchema, disputeNoteTargetSchema, disputeNoteCallerSchema, noteDisputeStateSchema,
  disputeNoteContextSchema, appendedNoteSchema, disputeNoteResultSchema, disputeNoteRowSchema,
  disputeNoteReadRowSchema, noteContextMatches,
};
