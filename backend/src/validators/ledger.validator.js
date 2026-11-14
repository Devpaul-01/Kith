// src/validators/ledger.validator.js
const { z } = require('zod');
const { SUPPORTED_CURRENCIES } = require('./auth.validator');

// ── Participants ──────────────────────────────────────────────────

const targetSchema = z.object({
  amount: z.number().positive(),
  currency: z.enum(SUPPORTED_CURRENCIES),
  due_date: z.string().date().optional().nullable(),
});

const addParticipantsSchema = z.object({
  participants: z
    .array(
      z.object({
        workspace_member_id: z.string().uuid(),
        money_enabled: z.boolean().optional().default(false),
        tasks_enabled: z.boolean().optional().default(false),
        role: z.string().max(80).optional(),
        notes: z.string().max(500).optional(),
        target: targetSchema.optional(),
      })
    )
    .min(1),
});

const addParticipantsFromGroupSchema = z.object({
  group_id: z.string().uuid(),
  money_enabled: z.boolean().optional().default(false),
  tasks_enabled: z.boolean().optional().default(false),
});

const updateParticipantSchema = z.object({
  money_enabled: z.boolean().optional(),
  tasks_enabled: z.boolean().optional(),
  role: z.string().max(80).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  exclude_from_public: z.boolean().optional(),
});

const setTargetSchema = z.object({
  amount: z.number().positive(),
  currency: z.enum(SUPPORTED_CURRENCIES),
  due_date: z.string().date().optional().nullable(),
});

// ── Ledger ────────────────────────────────────────────────────────

// The self-submission path uses decimal text matching numeric(15,2). Format
// normalization only removes leading zeroes and pads cents; it never rounds.
const selfLedgerAmountSchema = z.string().max(16)
  .regex(/^\d{1,13}(?:\.\d{1,2})?$/, 'Use a plain amount with at most two decimal places')
  .refine((value) => value === value.trim(), 'Amount must not contain surrounding whitespace')
  .refine((value) => /[1-9]/.test(value), 'Amount must be positive')
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
  });

function normalizeSelfLedgerAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const parsed = selfLedgerAmountSchema.safeParse(typeof value === 'number' ? String(value) : value);
  return parsed.success ? parsed.data : null;
}

const selfLedgerContextSchema = z.object({
  workspace_id: z.string().uuid(),
  base_currency: z.enum(SUPPORTED_CURRENCIES),
  container_id: z.string().uuid(),
  container_name: z.string().min(1).max(200),
  container_type: z.literal('event'),
  container_status: z.literal('active'),
  enable_money: z.literal(true),
  container_updated_at: z.string().datetime({ offset: true }),
  contributor_id: z.string().uuid(),
  member_role: z.enum(['member', 'admin']),
  participant_id: z.string().uuid(),
  money_enabled: z.literal(true),
}).strict();

// Remains a ZodObject so proposal validators can pick/extend its fields.
const selfLedgerSubmissionDataSchema = z.object({
  entry_type: z.literal('contribution'),
  contributor_id: z.string().uuid(),
  original_amount: selfLedgerAmountSchema,
  original_currency: z.enum(SUPPORTED_CURRENCIES),
  base_amount: selfLedgerAmountSchema,
  payment_method: z.enum(['cash', 'bank_transfer', 'mobile_money', 'other']).nullable().default(null),
  note: z.string().min(1).max(500).nullable().default(null),
  cycle_id: z.null().default(null),
  is_crypto: z.literal(false).default(false),
}).strict();

// A confirmation approves one complete pending entry, not just its ID. Keep
// these as strict ZodObjects so cards can project/extend the reviewed fields.
const entryConfirmationSnapshotSchema = z.object({
  entry_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  container_id: z.string().uuid(),
  contributor_id: z.string().uuid(),
  entry_type: z.literal('contribution'),
  original_amount: selfLedgerAmountSchema,
  original_currency: z.enum(SUPPORTED_CURRENCIES),
  base_amount: selfLedgerAmountSchema,
  payment_method: z.enum(['cash', 'bank_transfer', 'mobile_money', 'other']).nullable(),
  note: z.string().max(500).nullable(),
  cycle_id: z.null(),
  is_crypto: z.literal(false),
  proofs: z.array(z.never()).length(0),
  status: z.literal('pending'),
  corrects_entry_id: z.null(),
  recorded_by: z.string().uuid(),
  recorded_at: z.string().datetime({ offset: true }),
  confirmed_at: z.null(),
  confirmed_by: z.null(),
}).strict();

const entryConfirmationContextSchema = entryConfirmationSnapshotSchema.extend({
  base_currency: z.enum(SUPPORTED_CURRENCIES),
  container_name: z.string().min(1).max(200),
  container_type: z.literal('event'),
  container_status: z.literal('active'),
  enable_money: z.literal(true),
  container_updated_at: z.string().datetime({ offset: true }),
  actor_member_id: z.string().uuid(),
  member_role: z.literal('admin'),
  contributor_display_name: z.string().min(1).max(100),
  contributor_role: z.enum(['member', 'admin']),
  participant_id: z.string().uuid(),
  money_enabled: z.literal(true),
}).strict();

const createLedgerEntrySchema = z.object({
  entry_type: z.enum(['contribution', 'expense']),
  contributor_id: z.string().uuid().optional(),
  original_amount: z.number().positive(),
  original_currency: z.string().min(3).max(5),
  base_amount: z.number().positive(),
  payment_method: z
    .string()
    .transform((val, ctx) => {
      const cleaned = val.trim().toLowerCase();
      const known = {
        cash: 'cash',
        bank: 'bank_transfer', 'bank transfer': 'bank_transfer', bank_transfer: 'bank_transfer',
        'mobile money': 'mobile_money', mobile_money: 'mobile_money',
        crypto: 'crypto',
        other: 'other',
      };
      if (known[cleaned]) return known[cleaned];
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payment_method must be one of: cash, bank_transfer, mobile_money, crypto, other (received "${val}")`,
      });
      return z.NEVER;
    })
    .nullable()
    .optional(),
  note: z.string().max(500).optional(),
  cycle_id: z.string().uuid().optional().nullable(),
  is_crypto: z.boolean().optional().default(false),
});

const updateLedgerEntrySchema = z.object({
  original_amount: z.number().positive().optional(),
  original_currency: z.string().min(3).max(5).optional(),
  base_amount: z.number().positive().optional(),
  payment_method: z
    .enum(['cash', 'bank_transfer', 'mobile_money', 'crypto', 'other'])
    .optional()
    .nullable(),
  note: z.string().max(500).optional().nullable(),
  contributor_id: z.string().uuid().optional(), // admin only
});

const uploadFileSchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  file_size: z.number().int().positive(),
});

const confirmProofSchema = z.object({
  file_path: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mime_type: z.string().min(1),
});

const addCorrectionSchema = z.object({
  original_amount: z.number().positive(),
  original_currency: z.string().min(3).max(5),
  base_amount: z.number().positive(),
  note: z.string().min(10, 'Correction note must be at least 10 characters'),
});

// ── Disputes ──────────────────────────────────────────────────────

const createDisputeSchema = z.object({
  reason: z.string().min(5).max(1000),
});

const addDisputeNoteSchema = z.object({
  note: z.string().min(1).max(1000),
});

const resolveDisputeSchema = z.object({
  resolution_note: z.string().min(10, 'Resolution note must be at least 10 characters').max(1000),
});

// ── Tasks ─────────────────────────────────────────────────────────

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  assigned_to: z.string().uuid().optional().nullable(),
  due_date: z.string().date().optional().nullable(),
});

const bulkCreateTasksSchema = z.object({
  tasks: z.array(createTaskSchema).min(1).max(50),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
  due_date: z.string().date().optional().nullable(),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'overdue', 'cancelled'])
    .optional(),
  sort_order: z.number().int().optional(),
  completion_note: z.string().max(1000).optional().nullable(),
});

const reassignTaskSchema = z.object({
  assigned_to: z.string().uuid().nullable(),
});

const overrideTaskStatusSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'overdue', 'cancelled']),
  note: z.string().max(500).optional(),
});

// ── Cycles ────────────────────────────────────────────────────────

const cycleOverrideSchema = z.object({
  override_type: z.enum(['pause_pool', 'skip_member', 'adjust_target']),
  member_id: z.string().uuid().optional(),
  new_target: z.number().positive().optional(),
  new_currency: z.string().min(3).max(5).optional(),
  reason: z.string().max(500).optional(),
});

// ── Milestones ────────────────────────────────────────────────────

const createMilestoneSchema = z.object({
  title: z.string().min(1).max(200),
  milestone_date: z.string().date(),
  description: z.string().max(2000).optional(),
  milestone_type: z
    .enum(['birth', 'graduation', 'wedding', 'death', 'migration', 'achievement', 'custom'])
    .default('custom'),
});

const updateMilestoneSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  milestone_date: z.string().date().optional(),
  milestone_type: z
    .enum(['birth', 'graduation', 'wedding', 'death', 'migration', 'achievement', 'custom'])
    .optional(),
});

module.exports = {
  addParticipantsSchema,
  addParticipantsFromGroupSchema,
  updateParticipantSchema,
  setTargetSchema,
  selfLedgerAmountSchema,
  normalizeSelfLedgerAmount,
  selfLedgerContextSchema,
  selfLedgerSubmissionDataSchema,
  entryConfirmationSnapshotSchema,
  entryConfirmationContextSchema,
  createLedgerEntrySchema,
  updateLedgerEntrySchema,
  uploadFileSchema,
  confirmProofSchema,
  addCorrectionSchema,
  createDisputeSchema,
  addDisputeNoteSchema,
  resolveDisputeSchema,
  createTaskSchema,
  bulkCreateTasksSchema,
  updateTaskSchema,
  reassignTaskSchema,
  overrideTaskStatusSchema,
  cycleOverrideSchema,
  createMilestoneSchema,
  updateMilestoneSchema,
};
