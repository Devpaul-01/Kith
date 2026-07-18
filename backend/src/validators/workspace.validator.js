// src/validators/workspace.validator.js
const { z } = require('zod');
const { SUPPORTED_CURRENCIES } = require('./auth.validator');

// ── Workspace ──────────────────────────────────────────────────────

// Issue M8 fix: createWorkspaceSchema and updateWorkspaceSchema previously
// declared two DIFFERENT family_type enums inline. Both schemas now share
// one list.
//
// Audit finding 2.1 (resolved): this list was previously wider than the
// live DB constraint (which only allowed extended/event/pool), so a
// request with e.g. family_type: 'nuclear' passed validation here and
// then 500'd at the database layer. Resolved by widening the DATABASE to
// match this already-shipped validator surface — see
// migrations/0004_widen_family_type_and_recurrence_cadence.sql — rather
// than narrowing the validator, since narrowing would have been a
// breaking API change for any client already sending these values.
const FAMILY_TYPES = ['nuclear','extended','blended','community','association','other'];

// Fixes audit finding 2.2: createContainerSchema and convertToRecurringSchema
// previously validated the SAME containers.recurrence_cadence column with
// two different, hand-maintained enums 20 lines apart — one of which
// (createContainerSchema's) included 'weekly', a value the DB's CHECK
// constraint rejected, so a perfectly reasonable request could pass Zod
// validation and then 500 at the database layer.
//
// Migration 0004_widen_family_type_and_recurrence_cadence.sql widens the
// DB constraint to include 'weekly' (matching what this validator already
// advertised to clients), and background.workers.js's cycle-generation
// worker now has a `case 'weekly'` so the value is actually honored end
// to end, not just accepted and then silently treated as monthly.
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
//
// Centralized here (rather than manual if/typeof/trim checks in the
// controller) so announceToWorkspace stays clean.

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
    event_type:          z.string().max(80).optional(),
    event_type_category: z
      .enum(['celebration', 'memorial', 'financial', 'logistical', 'other'])
      .optional()
      .default('other'),
    // Recurring — now accepts null, matching how the frontend actually serializes "unused"
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
  updateContainerSchema,
  completeContainerSchema,
  convertToRecurringSchema,
  FAMILY_TYPES, // Issue M8: exported so it stays the single source of truth
  RECURRENCE_CADENCES,
};
