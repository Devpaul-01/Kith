// tests/unit/validators/workspace.validator.test.js
const {
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
  FAMILY_TYPES,
  RECURRENCE_CADENCES,
} = require('../../../src/validators/workspace.validator');
const { ZodError } = require('zod');

const uuid = '11111111-1111-4111-8111-111111111111';

describe('validators/workspace.validator', () => {
  describe('shared constants', () => {
    it('FAMILY_TYPES and RECURRENCE_CADENCES are non-empty arrays used consistently by their schemas', () => {
      expect(FAMILY_TYPES.length).toBeGreaterThan(0);
      expect(RECURRENCE_CADENCES.length).toBeGreaterThan(0);

      FAMILY_TYPES.forEach((ft) => {
        expect(() => createWorkspaceSchema.parse({ name: 'X Family', base_currency: 'USD', family_type: ft })).not.toThrow();
      });
    });
  });

  describe('createWorkspaceSchema', () => {
    it('accepts a minimal valid payload and defaults family_type to "extended"', () => {
      const result = createWorkspaceSchema.parse({ name: 'The Smiths', base_currency: 'USD' });
      expect(result.family_type).toBe('extended');
    });

    it('rejects an unsupported base_currency', () => {
      expect(() => createWorkspaceSchema.parse({ name: 'X', base_currency: 'XXX' })).toThrow(ZodError);
    });

    it('rejects a name shorter than 2 characters', () => {
      expect(() => createWorkspaceSchema.parse({ name: 'X', base_currency: 'USD' })).toThrow(ZodError);
    });
  });

  describe('updateWorkspaceSchema', () => {
    it('accepts an empty object', () => {
      expect(() => updateWorkspaceSchema.parse({})).not.toThrow();
    });

    it('accepts null for nullable fields', () => {
      expect(() => updateWorkspaceSchema.parse({ description: null, avatar_url: null })).not.toThrow();
    });

    it('rejects an invalid visibility value', () => {
      expect(() => updateWorkspaceSchema.parse({ visibility: 'secret' })).toThrow(ZodError);
    });
  });

  describe('updateSettingsSchema', () => {
    it('accepts a nested reminder_templates object', () => {
      expect(() =>
        updateSettingsSchema.parse({ reminder_templates: { due_soon: 'Reminder!', overdue: 'Overdue!' } })
      ).not.toThrow();
    });

    it('accepts a nested notification_prefs object with arrays', () => {
      expect(() =>
        updateSettingsSchema.parse({
          notification_prefs: { reminder_days_before: [1, 3, 7], weekly_digest_enabled: true },
        })
      ).not.toThrow();
    });

    it('rejects a negative value inside reminder_days_before', () => {
      expect(() =>
        updateSettingsSchema.parse({ notification_prefs: { reminder_days_before: [-1] } })
      ).toThrow(ZodError);
    });

    it('accepts a completely empty object', () => {
      expect(() => updateSettingsSchema.parse({})).not.toThrow();
    });
  });

  describe('announceSchema', () => {
    it('trims whitespace from title and body', () => {
      const result = announceSchema.parse({ title: '  Hello  ', body: '  World  ' });
      expect(result.title).toBe('Hello');
      expect(result.body).toBe('World');
    });

    it('rejects an empty title', () => {
      expect(() => announceSchema.parse({ title: '', body: 'x' })).toThrow(ZodError);
    });

    it('rejects an empty body', () => {
      expect(() => announceSchema.parse({ title: 'x', body: '' })).toThrow(ZodError);
    });

    it('rejects an invalid target_role', () => {
      expect(() => announceSchema.parse({ title: 'x', body: 'y', target_role: 'owner' })).toThrow(ZodError);
    });
  });

  describe('createMemberSchema', () => {
    it('applies defaults: is_proxy=false, role="member", relationship_category="other"', () => {
      const result = createMemberSchema.parse({ display_name: 'Aunt Sue' });
      expect(result.is_proxy).toBe(false);
      expect(result.role).toBe('member');
      expect(result.relationship_category).toBe('other');
    });

    it('rejects display_name shorter than 2 characters', () => {
      expect(() => createMemberSchema.parse({ display_name: 'X' })).toThrow(ZodError);
    });

    it('rejects an invalid relationship_category', () => {
      expect(() =>
        createMemberSchema.parse({ display_name: 'Aunt Sue', relationship_category: 'stranger' })
      ).toThrow(ZodError);
    });
  });

  describe('updateMemberSchema', () => {
    it('has no defaults anywhere — an empty object round-trips with all keys undefined', () => {
      const result = updateMemberSchema.parse({});
      expect(result.role).toBeUndefined();
      expect(result.is_proxy).toBeUndefined();
    });

    it('accepts a loosely-typed version string with no ISO-date validation', () => {
      // The optimistic-lock `version` field is just a non-empty string;
      // the real comparison against current.updated_at happens in the
      // service layer, not here.
      expect(() => updateMemberSchema.parse({ version: 'not-a-real-date' })).not.toThrow();
    });

    it('rejects a malformed proxy_managed_by UUID', () => {
      expect(() => updateMemberSchema.parse({ proxy_managed_by: 'nope' })).toThrow(ZodError);
    });
  });

  describe('createGroupSchema / updateGroupSchema / addGroupMembersSchema', () => {
    it('createGroupSchema defaults member_ids to an empty array', () => {
      const result = createGroupSchema.parse({ name: 'Cousins' });
      expect(result.member_ids).toEqual([]);
    });

    it('createGroupSchema rejects a name longer than 80 characters', () => {
      expect(() => createGroupSchema.parse({ name: 'x'.repeat(81) })).toThrow(ZodError);
    });

    it('updateGroupSchema accepts an empty object', () => {
      expect(() => updateGroupSchema.parse({})).not.toThrow();
    });

    it('addGroupMembersSchema rejects an empty member_ids array', () => {
      expect(() => addGroupMembersSchema.parse({ member_ids: [] })).toThrow(ZodError);
    });

    it('addGroupMembersSchema accepts one or more valid UUIDs', () => {
      expect(() => addGroupMembersSchema.parse({ member_ids: [uuid] })).not.toThrow();
    });
  });

  describe('createContainerSchema — superRefine matrix (most complex custom validation in the codebase)', () => {
    const eventBase = { name: 'Birthday Party', container_type: 'event' };
    const recurringBase = { name: 'Monthly Rent', container_type: 'recurring' };

    it('accepts a valid event container with no recurrence fields', () => {
      expect(() => createContainerSchema.parse(eventBase)).not.toThrow();
    });

    it('recurring container missing recurrence_cadence -> issue on that exact path', () => {
      try {
        createContainerSchema.parse({ ...recurringBase, recurrence_start: '2026-01-01' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'recurrence_cadence')).toBe(true);
      }
    });

    it('recurring container missing recurrence_start -> issue on that exact path', () => {
      try {
        createContainerSchema.parse({ ...recurringBase, recurrence_cadence: 'monthly' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'recurrence_start')).toBe(true);
      }
    });

    it('recurring container missing BOTH cadence and start -> BOTH issues present simultaneously', () => {
      try {
        createContainerSchema.parse(recurringBase);
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.length).toBe(2);
        const paths = err.errors.map((e) => e.path.join('.'));
        expect(paths).toContain('recurrence_cadence');
        expect(paths).toContain('recurrence_start');
      }
    });

    it('event container missing cadence/start -> NO issue (rule only applies to recurring)', () => {
      // Inverse case of the recurring checks above — must be tested
      // explicitly, not assumed from the positive case.
      expect(() => createContainerSchema.parse(eventBase)).not.toThrow();
    });

    it('recurring container WITH both cadence and start -> valid', () => {
      expect(() =>
        createContainerSchema.parse({
          ...recurringBase,
          recurrence_cadence: 'monthly',
          recurrence_start: '2026-01-01',
        })
      ).not.toThrow();
    });

    it('enable_money: false + budget_target set -> issue on budget_target', () => {
      try {
        createContainerSchema.parse({ ...eventBase, enable_money: false, budget_target: 500 });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'budget_target')).toBe(true);
      }
    });

    it('enable_money: false + budget_target: null -> NO issue (null treated as "not set")', () => {
      expect(() =>
        createContainerSchema.parse({ ...eventBase, enable_money: false, budget_target: null })
      ).not.toThrow();
    });

    it('enable_money: true + budget_target set -> NO issue', () => {
      expect(() =>
        createContainerSchema.parse({ ...eventBase, enable_money: true, budget_target: 500 })
      ).not.toThrow();
    });

    it('enable_money OMITTED (defaults to false) + budget_target set -> refine sees the DEFAULTED value and still rejects', () => {
      // Genuine Zod gotcha: confirms superRefine runs against the
      // post-default value, not the pre-default `undefined`.
      try {
        createContainerSchema.parse({ ...eventBase, budget_target: 500 });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'budget_target')).toBe(true);
      }
    });
  });

  describe('updateContainerSchema — no superRefine (cross-field rules NOT re-enforced on update)', () => {
    it('documents the gap: enable_money:false + budget_target set both PASS schema validation on update', () => {
      // Whether the service layer catches this is a separate concern
      // (container.service.js#updateContainer has its own guard) — this
      // schema alone does not.
      expect(() =>
        updateContainerSchema.parse({ enable_money: false, budget_target: 500 })
      ).not.toThrow();
    });

    it('accepts an empty object', () => {
      expect(() => updateContainerSchema.parse({})).not.toThrow();
    });

    it('rejects a cover_photos entry missing url', () => {
      expect(() =>
        updateContainerSchema.parse({ cover_photos: [{ path: '/x' }] })
      ).toThrow(ZodError);
    });

    it('rejects a cover_photos entry with a non-URL url', () => {
      expect(() =>
        updateContainerSchema.parse({ cover_photos: [{ url: 'not-a-url', path: '/x' }] })
      ).toThrow(ZodError);
    });
  });

  describe('completeContainerSchema', () => {
    it('defaults outcome_files to an empty array when omitted', () => {
      const result = completeContainerSchema.parse({});
      expect(result.outcome_files).toEqual([]);
    });

    it('rejects more than 10 outcome_files', () => {
      const files = Array.from({ length: 11 }, (_, i) => ({
        url: `f${i}`, name: `f${i}.png`, size: 10, mime_type: 'image/png',
      }));
      expect(() => completeContainerSchema.parse({ outcome_files: files })).toThrow(ZodError);
    });

    it('accepts exactly 10 outcome_files (boundary)', () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        url: `f${i}`, name: `f${i}.png`, size: 10, mime_type: 'image/png',
      }));
      expect(() => completeContainerSchema.parse({ outcome_files: files })).not.toThrow();
    });
  });

  describe('convertToRecurringSchema — no superRefine needed (fields required directly)', () => {
    it('accepts a valid payload', () => {
      expect(() =>
        convertToRecurringSchema.parse({ recurrence_cadence: 'monthly', recurrence_start: '2026-01-01' })
      ).not.toThrow();
    });

    it('throws a standard required-field error (not a custom refine message) when recurrence_cadence is omitted', () => {
      try {
        convertToRecurringSchema.parse({ recurrence_start: '2026-01-01' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'recurrence_cadence')).toBe(true);
      }
    });

    it('throws a standard required-field error when recurrence_start is omitted', () => {
      try {
        convertToRecurringSchema.parse({ recurrence_cadence: 'monthly' });
        throw new Error('expected parse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        expect(err.errors.some((e) => e.path.join('.') === 'recurrence_start')).toBe(true);
      }
    });

    it('defaults carry_forward_unpaid to false', () => {
      const result = convertToRecurringSchema.parse({
        recurrence_cadence: 'monthly',
        recurrence_start: '2026-01-01',
      });
      expect(result.carry_forward_unpaid).toBe(false);
    });
  });
});
