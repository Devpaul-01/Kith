const { z } = require('zod');
const { createDisputeSchema, entryConfirmationSnapshotSchema } = require('./ledger.validator');

const timestamp = z.string().max(35).datetime({ offset: true });
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const raiseDisputeDataSchema = z.object({
  reason: createDisputeSchema.shape.reason.trim().min(5)
    .refine((value) => !unsupportedText.test(value), 'Reason contains unsupported characters'),
}).strict();
const raiseDisputeTargetSchema = z.object({
  container_id: z.string().uuid().transform((id) => id.toLowerCase()),
  entry_id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();

// Confirmed-entry financial fields are immutable. Mutable proof metadata and
// private idempotency keys are outside this dispute approval projection.
const confirmedDisputeEntrySchema = entryConfirmationSnapshotSchema.omit({ proofs: true }).extend({
  status: z.literal('confirmed'), confirmed_at: timestamp.nullable(), confirmed_by: z.string().uuid().nullable(),
  recorded_by: z.string().uuid().nullable(), recorded_at: timestamp,
});
const storedAmount = z.string().regex(/^-?\d{1,13}(?:\.\d{1,2})?$/);
const disputeEntryReadSchema = confirmedDisputeEntrySchema.extend({
  contributor_id: z.string().uuid().nullable(),
  entry_type: z.enum(['contribution', 'expense', 'correction', 'reversal', 'carry_forward']),
  original_amount: storedAmount, base_amount: storedAmount, original_currency: z.string().min(1),
  payment_method: z.enum(['cash', 'bank_transfer', 'mobile_money', 'crypto', 'other']).nullable(),
  cycle_id: z.string().uuid().nullable(), is_crypto: z.boolean(), corrects_entry_id: z.string().uuid().nullable(),
  status: z.enum(['pending', 'proof_uploaded', 'confirmed', 'disputed', 'resolved', 'reversed']),
});
const disputedEntrySchema = confirmedDisputeEntrySchema.extend({ status: z.literal('disputed') });
const raiseDisputeContextSchema = z.object({
  workspace_id: z.string().uuid(), workspace_name: z.string().min(1).max(200), workspace_updated_at: timestamp,
  base_currency: confirmedDisputeEntrySchema.shape.original_currency,
  actor_member_id: z.string().uuid(), member_role: z.enum(['member', 'admin']),
  actor_display_name: z.string().min(1).max(200), member_updated_at: timestamp,
  container_id: z.string().uuid(), container_name: z.string().min(1).max(200),
  container_type: z.literal('event'), container_status: z.literal('active'), enable_money: z.literal(true),
  container_updated_at: timestamp, entry: confirmedDisputeEntrySchema, dispute: z.null(),
}).strict();
const disputeRaiseWorkspaceRowSchema = z.object({
  id: z.string().uuid(), name: raiseDisputeContextSchema.shape.workspace_name,
  base_currency: raiseDisputeContextSchema.shape.base_currency, updated_at: timestamp, deleted_at: timestamp.nullable(),
}).strip();
const disputeRaiseMemberRowSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), user_id: z.string().uuid().nullable(),
  role: z.enum(['member', 'admin']), is_active: z.boolean(), is_proxy: z.boolean(),
  display_name: raiseDisputeContextSchema.shape.actor_display_name, updated_at: timestamp, deleted_at: timestamp.nullable(),
}).strip();
const disputeRaiseContainerRowSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), name: raiseDisputeContextSchema.shape.container_name,
  container_type: z.enum(['event', 'recurring']), status: z.enum(['active', 'archived', 'completed']),
  enable_money: z.boolean(), updated_at: timestamp, deleted_at: timestamp.nullable(),
}).strip();
const disputeRaiseOpenRowSchema = z.object({
  id: z.string().uuid(), workspace_id: z.string().uuid(), ledger_entry_id: z.string().uuid(), status: z.literal('open'),
}).strip();
const raisedDisputeStateSchema = z.object({
  dispute_id: z.string().uuid(), workspace_id: z.string().uuid(), ledger_entry_id: z.string().uuid(),
  raised_by: z.string().uuid(), reason: createDisputeSchema.shape.reason,
  status: z.literal('open'), resolution_note: z.null(), resolved_by: z.null(),
  raised_at: timestamp, resolved_at: z.null(), notes: z.array(z.never()).length(0),
}).strict();
const raiseDisputeResultSchema = z.object({ dispute: raisedDisputeStateSchema, entry: disputedEntrySchema }).strict();
const raiseDisputeCallerSchema = z.object({
  workspaceId: z.string().uuid(), containerId: z.string().uuid(), entryId: z.string().uuid(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const disputeExecutionTraceSchema = z.object({
  sessionId: z.string().uuid(), conversationId: z.string().uuid().nullable(),
}).strict();
const reviewedDisputeRaiseSchema = z.object({
  userId: z.string().uuid(), isAdmin: z.boolean(), proposalId: z.string().uuid(),
  trace: disputeExecutionTraceSchema, expected: raiseDisputeContextSchema,
}).strict();

function disputeEntryState(row) {
  return Object.fromEntries(Object.keys(confirmedDisputeEntrySchema.shape)
    .map((field) => [field, field === 'entry_id' ? row?.id : row?.[field]]));
}
function raisedDisputeState(row) {
  return Object.fromEntries(Object.keys(raisedDisputeStateSchema.shape)
    .map((field) => [field, field === 'dispute_id' ? row?.id : row?.[field]]));
}
function plannedDisputeState({ selection, reason }) {
  const selected = raiseDisputeContextSchema.parse(selection);
  return { workspace_id: selected.workspace_id, ledger_entry_id: selected.entry.entry_id,
    raised_by: selected.actor_member_id, reason: raiseDisputeDataSchema.parse({ reason }).reason,
    status: 'open', resolution_note: null, resolved_by: null, resolved_at: null, notes: [] };
}

module.exports = {
  raiseDisputeDataSchema, raiseDisputeTargetSchema, confirmedDisputeEntrySchema, disputeEntryReadSchema, disputedEntrySchema,
  raiseDisputeContextSchema, raisedDisputeStateSchema, raiseDisputeResultSchema,
  disputeRaiseWorkspaceRowSchema, disputeRaiseMemberRowSchema, disputeRaiseContainerRowSchema, disputeRaiseOpenRowSchema,
  raiseDisputeCallerSchema, disputeExecutionTraceSchema, reviewedDisputeRaiseSchema,
  disputeEntryState, raisedDisputeState, plannedDisputeState,
};
