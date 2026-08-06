// tests/unit/validators/ledger.validator.test.js
const {
  addParticipantsSchema,
  addParticipantsFromGroupSchema,
  updateParticipantSchema,
  setTargetSchema,
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
} = require('../../../src/validators/ledger.validator');
const { ZodError } = require('zod');

const uuid = '11111111-1111-4111-8111-111111111111';
const uuid2 = '22222222-2222-4222-8222-222222222222';

describe('validators/ledger.validator', () => {
  describe('setTargetSchema (also used as the shape for addParticipantsSchema\'s nested target field)', () => {
    it('accepts a positive amount, valid currency, and valid due_date', () => {
      expect(() => setTargetSchema.parse({ amount: 100, currency: 'USD', due_date: '2026-08-01' })).not.toThrow();
    });

    it('rejects amount: 0 (positive excludes zero)', () => {
      expect(() => setTargetSchema.parse({ amount: 0, currency: 'USD' })).toThrow(ZodError);
    });

    it('rejects a negative amount', () => {
      expect(() => setTargetSchema.parse({ amount: -5, currency: 'USD' })).toThrow(ZodError);
    });

    it('accepts a small positive amount like 0.01', () => {
      expect(() => setTargetSchema.parse({ amount: 0.01, currency: 'USD' })).not.toThrow();
    });

    it('rejects an unsupported currency', () => {
      expect(() => setTargetSchema.parse({ amount: 10, currency: 'XXX' })).toThrow(ZodError);
    });

    it('accepts null due_date (optional + nullable)', () => {
      expect(() => setTargetSchema.parse({ amount: 10, currency: 'USD', due_date: null })).not.toThrow();
    });

    it('rejects a malformed due_date', () => {
      expect(() => setTargetSchema.parse({ amount: 10, currency: 'USD', due_date: 'not-a-date' })).toThrow(ZodError);
    });

    it('rejects an invalid calendar date (2024-13-01)', () => {
      expect(() => setTargetSchema.parse({ amount: 10, currency: 'USD', due_date: '2024-13-01' })).toThrow(ZodError);
    });
  });

  describe('addParticipantsSchema', () => {
    it('accepts a minimal valid participants array', () => {
      expect(() =>
        addParticipantsSchema.parse({ participants: [{ workspace_member_id: uuid }] })
      ).not.toThrow();
    });

    it('rejects an empty participants array', () => {
      expect(() => addParticipantsSchema.parse({ participants: [] })).toThrow(ZodError);
    });

    it('rejects a malformed workspace_member_id (not a UUID)', () => {
      expect(() =>
        addParticipantsSchema.parse({ participants: [{ workspace_member_id: 'not-a-uuid' }] })
      ).toThrow(ZodError);
    });

    it('rejects when a nested target is malformed (negative amount) — propagates through the array', () => {
      expect(() =>
        addParticipantsSchema.parse({
          participants: [
            { workspace_member_id: uuid, target: { amount: -10, currency: 'USD' } },
          ],
        })
      ).toThrow(ZodError);
    });

    it('accepts a valid nested target', () => {
      const result = addParticipantsSchema.parse({
        participants: [
          { workspace_member_id: uuid, target: { amount: 50, currency: 'USD' } },
        ],
      });
      expect(result.participants[0].target.amount).toBe(50);
    });

    it('defaults money_enabled/tasks_enabled to false when omitted', () => {
      const result = addParticipantsSchema.parse({ participants: [{ workspace_member_id: uuid }] });
      expect(result.participants[0].money_enabled).toBe(false);
      expect(result.participants[0].tasks_enabled).toBe(false);
    });
  });

  describe('addParticipantsFromGroupSchema', () => {
    it('accepts a valid group_id with defaults applied', () => {
      const result = addParticipantsFromGroupSchema.parse({ group_id: uuid });
      expect(result.money_enabled).toBe(false);
      expect(result.tasks_enabled).toBe(false);
    });

    it('rejects a malformed group_id', () => {
      expect(() => addParticipantsFromGroupSchema.parse({ group_id: 'nope' })).toThrow(ZodError);
    });
  });

  describe('updateParticipantSchema', () => {
    it('accepts an empty object (all optional)', () => {
      expect(() => updateParticipantSchema.parse({})).not.toThrow();
    });

    it('accepts explicit null for nullable fields', () => {
      expect(() => updateParticipantSchema.parse({ role: null, notes: null })).not.toThrow();
    });
  });

  describe('createLedgerEntrySchema — payment_method transform (highest-value validator)', () => {
    const base = {
      entry_type: 'contribution',
      original_amount: 50,
      original_currency: 'USD',
      base_amount: 50,
    };

    it.each([
      ['cash', 'cash'],
      ['Cash', 'cash'], // mixed case
      [' cash ', 'cash'], // whitespace trimmed
      ['bank', 'bank_transfer'],
      ['Bank Transfer', 'bank_transfer'],
      ['bank transfer', 'bank_transfer'],
      ['bank_transfer', 'bank_transfer'], // already-normalized passthrough
      ['mobile money', 'mobile_money'],
      ['mobile_money', 'mobile_money'],
      ['crypto', 'crypto'],
      ['other', 'other'],
    ])('normalizes payment_method %p to %p', (input, expected) => {
      const result = createLedgerEntrySchema.parse({ ...base, payment_method: input });
      expect(result.payment_method).toBe(expected);
    });

    it('REGRESSION (Issue M9): rejects an unknown payment_method rather than silently passing through', () => {
      // This is the exact bug the code comment documents as fixed —
      // an unrecognized value like "Venmo" must throw, not normalize
      // to some default value.
      expect(() => createLedgerEntrySchema.parse({ ...base, payment_method: 'Venmo' })).toThrow(ZodError);

      try {
        createLedgerEntrySchema.parse({ ...base, payment_method: 'Venmo' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors[0].message).toContain('payment_method must be one of');
      }
    });

    it('accepts payment_method omitted entirely (optional + nullable)', () => {
      const result = createLedgerEntrySchema.parse({ ...base });
      expect(result.payment_method).toBeUndefined();
    });

    it('accepts payment_method explicitly null', () => {
      const result = createLedgerEntrySchema.parse({ ...base, payment_method: null });
      expect(result.payment_method).toBeNull();
    });

    it('rejects original_amount: 0', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, original_amount: 0 })).toThrow(ZodError);
    });

    it('rejects a negative original_amount', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, original_amount: -5 })).toThrow(ZodError);
    });

    it('rejects base_amount: 0 independently of original_amount', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, base_amount: 0 })).toThrow(ZodError);
    });

    it('rejects a negative base_amount independently of original_amount', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, base_amount: -1 })).toThrow(ZodError);
    });

    it('rejects original_currency shorter than 3 characters', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, original_currency: 'US' })).toThrow(ZodError);
    });

    it('rejects original_currency longer than 5 characters', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, original_currency: 'ABCDEF' })).toThrow(ZodError);
    });

    it('accepts original_currency at the 3-char and 5-char boundaries', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, original_currency: 'USD' })).not.toThrow();
      expect(() => createLedgerEntrySchema.parse({ ...base, original_currency: 'ABCDE' })).not.toThrow();
    });

    it('rejects an invalid entry_type', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, entry_type: 'refund' })).toThrow(ZodError);
    });

    it('rejects a malformed cycle_id', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, cycle_id: 'not-a-uuid' })).toThrow(ZodError);
    });

    it('accepts null cycle_id', () => {
      expect(() => createLedgerEntrySchema.parse({ ...base, cycle_id: null })).not.toThrow();
    });

    it('defaults is_crypto to false when omitted', () => {
      const result = createLedgerEntrySchema.parse({ ...base });
      expect(result.is_crypto).toBe(false);
    });
  });

  describe('updateLedgerEntrySchema — plain enum, deliberately NOT the transform version', () => {
    it('accepts an already-normalized payment_method', () => {
      expect(() => updateLedgerEntrySchema.parse({ payment_method: 'bank_transfer' })).not.toThrow();
    });

    it('REJECTS a create-schema-accepted synonym, proving the two schemas are intentionally different', () => {
      // "Bank Transfer" is accepted (and normalized) by createLedgerEntrySchema
      // but update requests must send already-normalized values.
      expect(() => updateLedgerEntrySchema.parse({ payment_method: 'Bank Transfer' })).toThrow(ZodError);
    });

    it('accepts an empty object — every field optional', () => {
      expect(() => updateLedgerEntrySchema.parse({})).not.toThrow();
    });

    it('accepts null payment_method', () => {
      expect(() => updateLedgerEntrySchema.parse({ payment_method: null })).not.toThrow();
    });
  });

  describe('uploadFileSchema / confirmProofSchema', () => {
    it('accepts a valid uploadFileSchema payload', () => {
      expect(() =>
        uploadFileSchema.parse({ filename: 'a.png', content_type: 'image/png', file_size: 1024 })
      ).not.toThrow();
    });

    it('rejects a non-positive file_size', () => {
      expect(() =>
        uploadFileSchema.parse({ filename: 'a.png', content_type: 'image/png', file_size: 0 })
      ).toThrow(ZodError);
    });

    it('rejects a non-integer file_size', () => {
      expect(() =>
        uploadFileSchema.parse({ filename: 'a.png', content_type: 'image/png', file_size: 10.5 })
      ).toThrow(ZodError);
    });

    it('accepts a valid confirmProofSchema payload', () => {
      expect(() =>
        confirmProofSchema.parse({ file_path: 'p', name: 'a.png', size: 10, mime_type: 'image/png' })
      ).not.toThrow();
    });
  });

  describe('addCorrectionSchema', () => {
    const base = { original_amount: 10, original_currency: 'USD', base_amount: 10 };

    it('rejects a note of exactly 9 characters (below the 10-char minimum)', () => {
      expect(() => addCorrectionSchema.parse({ ...base, note: '123456789' })).toThrow(ZodError);
    });

    it('accepts a note of exactly 10 characters (boundary)', () => {
      expect(() => addCorrectionSchema.parse({ ...base, note: '1234567890' })).not.toThrow();
    });

    it('surfaces the custom min-length message, not Zod\'s generic one', () => {
      try {
        addCorrectionSchema.parse({ ...base, note: 'short' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors[0].message).toBe('Correction note must be at least 10 characters');
      }
    });
  });

  describe('createDisputeSchema / addDisputeNoteSchema / resolveDisputeSchema', () => {
    it('createDisputeSchema rejects a reason shorter than 5 characters', () => {
      expect(() => createDisputeSchema.parse({ reason: 'bad' })).toThrow(ZodError);
    });

    it('createDisputeSchema accepts a valid reason', () => {
      expect(() => createDisputeSchema.parse({ reason: 'This looks wrong' })).not.toThrow();
    });

    it('addDisputeNoteSchema rejects an empty note', () => {
      expect(() => addDisputeNoteSchema.parse({ note: '' })).toThrow(ZodError);
    });

    it('resolveDisputeSchema enforces the same 10-char custom-message minimum as addCorrectionSchema', () => {
      try {
        resolveDisputeSchema.parse({ resolution_note: 'short' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors[0].message).toBe('Resolution note must be at least 10 characters');
      }
    });

    it('resolveDisputeSchema accepts a boundary 10-char note', () => {
      expect(() => resolveDisputeSchema.parse({ resolution_note: '1234567890' })).not.toThrow();
    });
  });

  describe('createTaskSchema / bulkCreateTasksSchema', () => {
    it('accepts a minimal valid task', () => {
      expect(() => createTaskSchema.parse({ title: 'Do the thing' })).not.toThrow();
    });

    it('rejects an empty title', () => {
      expect(() => createTaskSchema.parse({ title: '' })).toThrow(ZodError);
    });

    it('bulkCreateTasksSchema rejects 0 tasks (below min 1)', () => {
      expect(() => bulkCreateTasksSchema.parse({ tasks: [] })).toThrow(ZodError);
    });

    it('bulkCreateTasksSchema accepts exactly 50 tasks (boundary)', () => {
      const tasks = Array.from({ length: 50 }, (_, i) => ({ title: `Task ${i}` }));
      expect(() => bulkCreateTasksSchema.parse({ tasks })).not.toThrow();
    });

    it('bulkCreateTasksSchema rejects 51 tasks (boundary)', () => {
      const tasks = Array.from({ length: 51 }, (_, i) => ({ title: `Task ${i}` }));
      expect(() => bulkCreateTasksSchema.parse({ tasks })).toThrow(ZodError);
    });
  });

  describe('updateTaskSchema', () => {
    it.each(['pending', 'in_progress', 'completed', 'overdue', 'cancelled'])(
      'accepts status %p at the schema level (service layer further restricts by role)',
      (status) => {
        expect(() => updateTaskSchema.parse({ status })).not.toThrow();
      }
    );

    it('rejects an invalid status', () => {
      expect(() => updateTaskSchema.parse({ status: 'archived' })).toThrow(ZodError);
    });
  });

  describe('reassignTaskSchema / overrideTaskStatusSchema', () => {
    it('reassignTaskSchema accepts null assigned_to (unassign)', () => {
      expect(() => reassignTaskSchema.parse({ assigned_to: null })).not.toThrow();
    });

    it('reassignTaskSchema requires the assigned_to key (nullable, not optional)', () => {
      expect(() => reassignTaskSchema.parse({})).toThrow(ZodError);
    });

    it('overrideTaskStatusSchema rejects an invalid status', () => {
      expect(() => overrideTaskStatusSchema.parse({ status: 'nope' })).toThrow(ZodError);
    });
  });

  describe('cycleOverrideSchema — cross-field rules are SERVICE-layer only, not schema-enforced', () => {
    it('accepts skip_member with NO member_id at the schema level (service must reject it)', () => {
      // participant.service.js#overrideCycle manually checks
      // `if (data.override_type === 'skip_member' && !data.member_id) throw ...`
      // — this schema alone does not enforce that cross-field rule.
      expect(() => cycleOverrideSchema.parse({ override_type: 'skip_member' })).not.toThrow();
    });

    it('accepts adjust_target with NO new_target at the schema level (service must reject it)', () => {
      expect(() => cycleOverrideSchema.parse({ override_type: 'adjust_target' })).not.toThrow();
    });

    it('rejects an invalid override_type', () => {
      expect(() => cycleOverrideSchema.parse({ override_type: 'nope' })).toThrow(ZodError);
    });
  });

  describe('createMilestoneSchema / updateMilestoneSchema', () => {
    it('createMilestoneSchema defaults milestone_type to "custom" when omitted', () => {
      const result = createMilestoneSchema.parse({ title: 'Grad', milestone_date: '2026-06-01' });
      expect(result.milestone_type).toBe('custom');
    });

    it('createMilestoneSchema rejects an invalid milestone_type', () => {
      expect(() =>
        createMilestoneSchema.parse({ title: 'X', milestone_date: '2026-06-01', milestone_type: 'party' })
      ).toThrow(ZodError);
    });

    it('createMilestoneSchema requires milestone_date', () => {
      expect(() => createMilestoneSchema.parse({ title: 'X' })).toThrow(ZodError);
    });

    it('updateMilestoneSchema has no default for milestone_type (asymmetric with create, all-optional patch)', () => {
      const result = updateMilestoneSchema.parse({});
      expect(result.milestone_type).toBeUndefined();
    });
  });
});
