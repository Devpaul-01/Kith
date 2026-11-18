const { z } = require('zod');
const { resolveDisputeSchema } = require('./ledger.validator');
const {
  disputedEntrySchema, raisedDisputeStateSchema, raiseDisputeContextSchema, disputeExecutionTraceSchema,
} = require('./dispute-raise.validator');

const timestamp = z.string().max(35).datetime({ offset: true });
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const resolutionNoteValueSchema = resolveDisputeSchema.shape.resolution_note
  .refine((value) => !unsupportedText.test(value), 'Resolution note contains unsupported characters');
const resolveDisputeDataSchema = z.object({
  resolution_note: z.string().trim().pipe(resolutionNoteValueSchema),
}).strict();
const resolveDisputeTargetSchema = z.object({
  dispute_id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();

// A resolution approves the disputed financial projection and closing fields.
// Mutable proofs, appended notes and private idempotency keys are not reviewed.
const disputedResolutionEntrySchema = disputedEntrySchema.extend({
  confirmed_at: timestamp, confirmed_by: z.string().uuid(),
});
const resolvedDisputeEntrySchema = disputedResolutionEntrySchema.extend({ status: z.literal('resolved') });
const openDisputeResolutionSchema = raisedDisputeStateSchema.omit({ notes: true });
const disputeResolutionReadSchema = openDisputeResolutionSchema.extend({
  status: z.enum(['open', 'resolved']), resolution_note: z.string().max(1000).nullable(),
  resolved_by: z.string().uuid().nullable(), resolved_at: timestamp.nullable(),
});
const resolvedDisputeStateSchema = openDisputeResolutionSchema.extend({
  status: z.literal('resolved'), resolution_note: resolutionNoteValueSchema,
  resolved_by: z.string().uuid(), resolved_at: timestamp,
});
const resolveDisputeContextSchema = raiseDisputeContextSchema.extend({
  member_role: z.literal('admin'), entry: disputedResolutionEntrySchema, dispute: openDisputeResolutionSchema,
  contributor_display_name: raiseDisputeContextSchema.shape.actor_display_name,
  contributor_role: z.enum(['member', 'admin']), contributor_updated_at: timestamp,
});
const resolveDisputeResultSchema = z.object({
  dispute: resolvedDisputeStateSchema, entry: resolvedDisputeEntrySchema,
}).strict();
const resolveDisputeCallerSchema = z.object({
  workspaceId: z.string().uuid(), disputeId: z.string().uuid(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const reviewedDisputeResolutionSchema = z.object({
  userId: z.string().uuid(), isAdmin: z.literal(true), proposalId: z.string().uuid(),
  trace: disputeExecutionTraceSchema, expected: resolveDisputeContextSchema,
}).strict();

function disputeResolutionState(row) {
  return Object.fromEntries(Object.keys(openDisputeResolutionSchema.shape)
    .map((field) => [field, field === 'dispute_id' ? row?.id : row?.[field]]));
}
function resolutionContextMatches(selection) {
  return selection.entry.workspace_id === selection.workspace_id
    && selection.entry.container_id === selection.container_id
    && selection.dispute.workspace_id === selection.workspace_id
    && selection.dispute.ledger_entry_id === selection.entry.entry_id
    && selection.dispute.raised_by === selection.entry.contributor_id
    && selection.entry.original_currency === selection.base_currency
    && selection.entry.original_amount === selection.entry.base_amount;
}
function plannedResolvedDisputeState({ selection, resolutionNote, resolvedAt = 'on_confirmation' }) {
  const selected = resolveDisputeContextSchema.parse(selection);
  return { ...selected.dispute, status: 'resolved',
    resolution_note: resolveDisputeDataSchema.parse({ resolution_note: resolutionNote }).resolution_note,
    resolved_by: selected.actor_member_id, resolved_at: resolvedAt };
}

module.exports = {
  resolveDisputeDataSchema, resolveDisputeTargetSchema, disputedResolutionEntrySchema, resolvedDisputeEntrySchema,
  openDisputeResolutionSchema, disputeResolutionReadSchema, resolvedDisputeStateSchema,
  resolveDisputeContextSchema, resolveDisputeResultSchema, resolveDisputeCallerSchema, reviewedDisputeResolutionSchema,
  disputeResolutionState, resolutionContextMatches, plannedResolvedDisputeState,
};
