const { z } = require('zod');
const { addParticipantsSchema } = require('./ledger.validator');

const timestamp = z.string().max(35).datetime({ offset: true });
const fields = addParticipantsSchema.shape.participants.element.shape;
const participantAdditionTargetSchema = z.object({
  container_id: z.string().uuid().transform((id) => id.toLowerCase()),
  member_id: z.string().uuid().transform((id) => id.toLowerCase()),
}).strict();
const participantAdditionDataSchema = z.object({
  workspace_member_id: fields.workspace_member_id,
  money_enabled: fields.money_enabled,
  tasks_enabled: fields.tasks_enabled,
}).strict();
const participantAdditionContextSchema = z.object({
  workspace_id: z.string().uuid(), workspace_name: z.string().min(1).max(200), workspace_updated_at: timestamp,
  actor_member_id: z.string().uuid(), member_role: z.literal('admin'),
  container_id: z.string().uuid(), container_name: z.string().min(1).max(200),
  container_type: z.literal('event'), container_status: z.literal('active'),
  enable_money: z.boolean(), enable_tasks: z.boolean(), container_updated_at: timestamp,
  workspace_member_id: z.string().uuid(), display_name: z.string().min(1).max(200),
  selected_member_role: z.enum(['member', 'admin']), selected_member_active: z.literal(true),
  selected_member_proxy: z.literal(false), selected_member_updated_at: timestamp,
  participant: z.null(),
}).strict();
const participantAdditionStateSchema = z.object({
  participant_id: z.string().uuid(), container_id: z.string().uuid(), workspace_member_id: z.string().uuid(),
  money_enabled: z.boolean(), tasks_enabled: z.boolean(), role: z.null(), notes: z.null(),
  exclude_from_public: z.literal(false), added_by: z.string().uuid(),
}).strict();
const participantAdditionRowSchema = participantAdditionStateSchema.extend({ added_at: timestamp });
const participantAdditionCallerSchema = z.object({
  workspaceId: z.string().uuid(), containerId: z.string().uuid(), memberId: z.string().uuid(),
  callerId: z.string().uuid(), userId: z.string().uuid(), isAdmin: z.boolean(),
}).strict();
const reviewedParticipantAdditionSchema = z.object({
  userId: z.string().uuid(), isAdmin: z.boolean(), participantId: z.string().uuid(),
  expected: participantAdditionContextSchema,
}).strict();

function buildParticipantAdditionState({ data, containerId, participantId, actorMemberId }) {
  return participantAdditionStateSchema.parse({
    ...participantAdditionDataSchema.parse(data), participant_id: participantId,
    container_id: containerId, role: null, notes: null, exclude_from_public: false, added_by: actorMemberId,
  });
}
function participantAdditionState(row) {
  return Object.fromEntries(Object.keys(participantAdditionRowSchema.shape)
    .map((field) => [field, field === 'participant_id' ? row?.id : row?.[field]]));
}

module.exports = {
  participantAdditionTargetSchema, participantAdditionDataSchema, participantAdditionContextSchema,
  participantAdditionStateSchema, participantAdditionRowSchema, participantAdditionCallerSchema,
  reviewedParticipantAdditionSchema, buildParticipantAdditionState, participantAdditionState,
};
