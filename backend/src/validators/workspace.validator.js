// src/validators/workspace.validator.js
const { z } = require('zod');
const { SUPPORTED_CURRENCIES } = require('./auth.validator');

// ── Workspace ──────────────────────────────────────────────────────

const FAMILY_TYPES = ['nuclear','extended','blended','community','association','other'];

const RECURRENCE_CADENCES = ['monthly', 'weekly', 'quarterly', 'yearly', 'custom'];

const createWorkspaceSchema = z.object({
  name:          z.string().min(2).max(80),
  base_currency: z.enum(SUPPORTED_CURRENCIES),
  family_type:   z.enum(FAMILY_TYPES).optional().default('extended'),
  description:   z.string().max(500).optional(),
});

const updateWorkspaceSchema = z.object({
  name:          z.string().min(2).max(80).optional(),
  base_currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  family_type:   z.enum(FAMILY_TYPES).optional(),
  description:   z.string().max(500).optional().nullable(),
  avatar_url:    z.string().url().optional().nullable(),
  visibility:    z.enum(['private', 'public']).optional(),
});

const updateSettingsSchema = z.object({
  reminder_templates: z
    .object({
      due_soon: z.string().max(500).optional(),
      overdue:  z.string().max(500).optional(),
    })
    .optional(),
  notification_prefs: z
    .object({
      reminder_days_before:       z.array(z.number().int().min(0)).optional(),
      overdue_notify_after_days:  z.array(z.number().int().min(0)).optional(),
      weekly_digest_enabled:      z.boolean().optional(),
    })
    .optional(),
  invite_message: z
    .object({ template: z.string().max(500).optional() })
    .optional(),
});

// ── Announce ──────────────────────────────────────────────────────

const announceSchema = z.object({
  title:       z.string().min(1, 'title is required').max(200).trim(),
  body:        z.string().min(1, 'body is required').max(2000).trim(),
  target_role: z.enum(['admin', 'member']).optional(),
});

// ── Member ─────────────────────────────────────────────────────────

const createMemberSchema = z.object({
  display_name:          z.string().min(2).max(80),
  is_proxy:              z.boolean().default(false),
  proxy_managed_by:      z.string().uuid().optional().nullable(),
  role:                  z.enum(['admin', 'member']).optional().default('member'),
  relationship_to_head:  z.string().max(100).optional(),
  relationship_category: z
    .enum(['blood', 'marriage', 'in_law', 'friend', 'other'])
    .optional()
    .default('other'),
  date_of_birth: z.string().date().optional().nullable(),
  admin_notes:   z.string().max(1000).optional(),
});

const updateMemberSchema = z.object({
  display_name:          z.string().min(2).max(80).optional(),
  relationship_to_head:  z.string().max(100).optional().nullable(),
  relationship_category: z
    .enum(['blood', 'marriage', 'in_law', 'friend', 'other'])
    .optional(),
  date_of_birth:    z.string().date().optional().nullable(),
  role:             z.enum(['admin', 'member']).optional(),
  is_proxy:         z.boolean().optional(),
  proxy_managed_by: z.string().uuid().optional().nullable(),
  is_active:        z.boolean().optional(),
  admin_notes:      z.string().max(1000).optional().nullable(),
  // optimistic lock
  version:          z.string().optional(), // updated_at timestamp
});

// ── Group ──────────────────────────────────────────────────────────

const createGroupSchema = z.object({
  name:        z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  member_ids:  z.array(z.string().uuid()).optional().default([]),
});

const updateGroupSchema = z.object({
  name:        z.string().min(1).max(80).optional(),
  description: z.string().max(300).optional().nullable(),
});

const addGroupMembersSchema = z.object({
  member_ids: z.array(z.string().uuid()).min(1),
});

// ── Container ─────────────────────────────────────────────────────

const createContainerSchema = z
  .object({
    name:                z.string().min(2).max(100),
    subtitle:            z.string().max(200).optional(),
    description:         z.string().max(2000).optional(),
    container_type:      z.enum(['event', 'recurring']),
    enable_money:        z.boolean().default(false),
    enable_tasks:        z.boolean().default(false),
    // Event
    event_date:          z.string().date().optional().nullable(),
    event_type: z.string().max(80).optional().nullable(),
    event_type_category: z
      .enum(['celebration', 'memorial', 'financial', 'logistical', 'other'])
      .optional()
      .default('other'),
    // Recurring — accepts null, matching how the frontend serializes "unused"
    recurrence_cadence:  z.enum(RECURRENCE_CADENCES).optional().nullable(),
    recurrence_days:     z.number().int().min(1).optional().nullable(),
    recurrence_start:    z.string().date().optional().nullable(),
    recurrence_end:      z.string().date().optional().nullable(),
    carry_forward_unpaid: z.boolean().optional().default(false),
    // Money
    budget_target:       z.number().positive().optional().nullable(),
    budget_currency:     z.enum(SUPPORTED_CURRENCIES).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.container_type === 'recurring') {
      if (!data.recurrence_cadence) {
        ctx.addIssue({ path: ['recurrence_cadence'], message: 'Required for recurring containers', code: 'custom' });
      }
      if (!data.recurrence_start) {
        ctx.addIssue({ path: ['recurrence_start'], message: 'Required for recurring containers', code: 'custom' });
      }
    }
    if (data.enable_money === false && data.budget_target != null) {
      ctx.addIssue({ path: ['budget_target'], message: 'budget_target requires enable_money=true', code: 'custom' });
    }
  });

// Agent event creation uses the existing field constraints, with canonical
// text and explicit defaults so the reviewed card matches the stored row.
const containerCreationFields = createContainerSchema.innerType().shape;
const unsupportedContainerCreationText = /[\u0000\uD800-\uDFFF]/u;
const supportedContainerCreationText = (field) => field.refine(
  (value) => !unsupportedContainerCreationText.test(value), 'Text contains unsupported characters',
);
const canonicalContainerText = (field) => supportedContainerCreationText(field.trim())
  .transform((value) => value || null).nullable().default(null);
const containerCreationCategorySchema = containerCreationFields.event_type_category.removeDefault().unwrap();
const containerCreationDateSchema = containerCreationFields.event_date.unwrap().unwrap();
const containerCreationEventTypeSchema = containerCreationFields.event_type.unwrap().unwrap();

const eventContainerCreationDataSchema = z.object({
  name: supportedContainerCreationText(containerCreationFields.name.trim().min(2)),
  subtitle: canonicalContainerText(containerCreationFields.subtitle.unwrap()),
  description: canonicalContainerText(containerCreationFields.description.unwrap()),
  container_type: z.literal('event'),
  enable_money: containerCreationFields.enable_money,
  enable_tasks: containerCreationFields.enable_tasks,
  event_date: containerCreationDateSchema.nullable().default(null),
  event_type: canonicalContainerText(containerCreationEventTypeSchema),
  event_type_category: containerCreationCategorySchema.default('other'),
}).strict();

const containerCreationContextSchema = z.object({
  workspace_id: z.string().uuid(),
  workspace_name: createWorkspaceSchema.shape.name,
  workspace_updated_at: z.string().datetime({ offset: true }),
  actor_member_id: z.string().uuid(),
  member_role: z.literal('admin'),
}).strict();

// Stored-state fields are required and never normalize missing or unexpected
// values into the reviewed defaults. Execution timestamps live in the result.
const eventContainerCreationStateSchema = z.object({
  container_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: containerCreationFields.name,
  subtitle: containerCreationFields.subtitle.unwrap().nullable(),
  description: containerCreationFields.description.unwrap().nullable(),
  container_type: z.literal('event'),
  enable_money: containerCreationFields.enable_money.removeDefault(),
  enable_tasks: containerCreationFields.enable_tasks.removeDefault(),
  event_date: containerCreationDateSchema.nullable(),
  event_type: containerCreationEventTypeSchema.nullable(),
  event_type_category: containerCreationCategorySchema,
  recurrence_cadence: z.null(), recurrence_days: z.null(),
  recurrence_start: z.null(), recurrence_end: z.null(),
  carry_forward_unpaid: z.literal(false), auto_generate_cycles: z.literal(true),
  budget_target: z.null(), budget_currency: z.null(),
  public_token: z.null(), public_show_names: z.literal(true),
  cover_photos: z.array(z.never()).length(0), status: z.literal('active'),
  outcome_details: z.null(), outcome_files: z.array(z.never()).length(0),
  converted_from_id: z.null(), completed_at: z.null(), deleted_at: z.null(),
  created_by: z.string().uuid(),
}).strict();

function buildEventContainerCreationState({ data, workspaceId, containerId, actorMemberId }) {
  return eventContainerCreationStateSchema.parse({
    ...eventContainerCreationDataSchema.parse(data),
    container_id: containerId, workspace_id: workspaceId, created_by: actorMemberId,
    recurrence_cadence: null, recurrence_days: null, recurrence_start: null, recurrence_end: null,
    carry_forward_unpaid: false, auto_generate_cycles: true,
    budget_target: null, budget_currency: null, public_token: null, public_show_names: true,
    cover_photos: [], status: 'active', outcome_details: null, outcome_files: [],
    converted_from_id: null, completed_at: null, deleted_at: null,
  });
}

const updateContainerSchema = z.object({
  name:                z.string().min(2).max(100).optional(),
  subtitle:            z.string().max(200).optional().nullable(),
  description:         z.string().max(2000).optional().nullable(),
  event_date:          z.string().date().optional().nullable(),
  event_type:          z.string().max(80).optional().nullable(),
  event_type_category: z
    .enum(['celebration', 'memorial', 'financial', 'logistical', 'other'])
    .optional(),
  budget_target:        z.number().positive().optional().nullable(),
  budget_currency:      z.enum(SUPPORTED_CURRENCIES).optional().nullable(),
  public_show_names:    z.boolean().optional(),
  carry_forward_unpaid: z.boolean().optional(),
  recurrence_end:       z.string().date().optional().nullable(),
  enable_tasks:         z.boolean().optional(),
  enable_money:         z.boolean().optional(),
  cover_photos:         z.array(z.object({
    url:         z.string().url(),
    path:        z.string(),
    uploaded_at: z.string().datetime().optional(),
  })).optional(),
});

const completeContainerSchema = z.object({
  outcome_details: z.string().max(5000).optional(),
  outcome_files: z
    .array(
      z.object({
        url:      z.string(),
        name:     z.string(),
        size:     z.number().int(),
        mime_type: z.string(),
      })
    )
    .max(10)
    .optional()
    .default([]),
});

const convertToRecurringSchema = z.object({
  recurrence_cadence:   z.enum(RECURRENCE_CADENCES),
  recurrence_days:      z.number().int().min(1).optional(),
  recurrence_start:     z.string().date(),
  recurrence_end:       z.string().date().optional().nullable(),
  carry_forward_unpaid: z.boolean().optional().default(false),
  new_name:             z.string().min(2).max(100).optional(),
});

module.exports = {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  updateSettingsSchema,
  announceSchema,
  createMemberSchema,
  updateMemberSchema,
  createGroupSchema,
  updateGroupSchema,
  addGroupMembersSchema,
  createContainerSchema,
  eventContainerCreationDataSchema,
  containerCreationContextSchema,
  eventContainerCreationStateSchema,
  buildEventContainerCreationState,
  updateContainerSchema,
  completeContainerSchema,
  convertToRecurringSchema,
  FAMILY_TYPES,
  RECURRENCE_CADENCES,
};
