const { z } = require('zod');
const { createMemberSchema, createWorkspaceSchema } = require('./workspace.validator');

const fields = createMemberSchema.shape;
const unsupportedText = /[\u0000\uD800-\uDFFF]/u;
const supportedText = (field) => field.refine(
  (value) => !unsupportedText.test(value), 'Text contains unsupported characters',
);
const canonicalOptionalText = (field) => supportedText(field.trim())
  .transform((value) => value || null).nullable().default(null);
const relationshipCategorySchema = fields.relationship_category.removeDefault().unwrap();
const dateOfBirthSchema = fields.date_of_birth.unwrap().unwrap();

// Only requested member details are model-controlled. Account linking, role,
// proxy manager, workspace and record defaults belong to the service.
const memberCreationDataSchema = z.object({
  display_name: supportedText(fields.display_name.trim().min(2)),
  is_proxy: fields.is_proxy,
  relationship_to_head: canonicalOptionalText(fields.relationship_to_head.unwrap()),
  relationship_category: relationshipCategorySchema.default('other'),
  date_of_birth: dateOfBirthSchema.nullable().default(null),
  admin_notes: canonicalOptionalText(fields.admin_notes.unwrap()),
}).strict();

const memberCreationContextSchema = z.object({
  workspace_id: z.string().uuid(),
  workspace_name: createWorkspaceSchema.shape.name,
  workspace_updated_at: z.string().datetime({ offset: true }),
  actor_member_id: z.string().uuid(),
  member_role: z.literal('admin'),
}).strict();

// Stored fields are required; parsing a response must never restore missing
// values from defaults. Execution timestamps are kept outside this state.
const memberCreationStateSchema = z.object({
  member_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  user_id: z.null(),
  role: z.literal('member'),
  display_name: fields.display_name,
  relationship_to_head: fields.relationship_to_head.unwrap().nullable(),
  relationship_category: relationshipCategorySchema,
  date_of_birth: dateOfBirthSchema.nullable(),
  is_proxy: fields.is_proxy.removeDefault(),
  proxy_managed_by: z.string().uuid().nullable(),
  admin_notes: fields.admin_notes.unwrap().nullable(),
  invite_status: z.null(),
  invited_at: z.null(),
  last_active_at: z.null(),
  contribution_streak_months: z.literal(0),
  last_contribution_date: z.null(),
  is_active: z.literal(true),
  deleted_at: z.null(),
}).strict();

function buildMemberCreationState({ data, workspaceId, memberId, actorMemberId }) {
  const approved = memberCreationDataSchema.parse(data);
  return memberCreationStateSchema.parse({
    ...approved, member_id: memberId, workspace_id: workspaceId,
    user_id: null, role: 'member',
    proxy_managed_by: approved.is_proxy ? actorMemberId : null,
    invite_status: null, invited_at: null, last_active_at: null,
    contribution_streak_months: 0, last_contribution_date: null,
    is_active: true, deleted_at: null,
  });
}

module.exports = {
  memberCreationDataSchema,
  memberCreationContextSchema,
  memberCreationStateSchema,
  buildMemberCreationState,
};
