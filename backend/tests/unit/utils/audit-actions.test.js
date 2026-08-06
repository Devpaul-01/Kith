// tests/unit/utils/audit-actions.test.js
//
// Placed under tests/unit/utils per the existing test file layout in
// this project (audit-actions.js lives in src/constants/, but there is
// no tests/unit/constants directory convention established elsewhere —
// grouping with the other small pure-logic unit tests keeps discovery
// simple; testMatch picks up any tests/unit/**/*.test.js regardless of
// subfolder name).

const {
  AUDIT_ACTIONS,
  AUDIT_ACTION_DESCRIPTIONS,
  describeAuditAction,
} = require('../../../src/constants/audit-actions');

describe('constants/audit-actions', () => {
  it('has a description entry for every action in AUDIT_ACTIONS (exhaustive cross-reference)', () => {
    // Fails CI immediately if a new action is added to the enum without
    // a matching human-readable description, rather than relying on a
    // human to remember to update both maps in lockstep.
    Object.values(AUDIT_ACTIONS).forEach((action) => {
      expect(AUDIT_ACTION_DESCRIPTIONS[action]).toBeDefined();
      expect(typeof AUDIT_ACTION_DESCRIPTIONS[action]).toBe('string');
    });
  });

  describe('describeAuditAction', () => {
    it('prioritizes metadata.fields over the static description map, even for a known action', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.CONTAINER_SETTINGS_CHANGED, {
        fields: ['name', 'budget_target'],
      });
      expect(result).toBe('changed name, budget_target');
    });

    it('uses metadata.keys when fields is absent', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, {
        keys: ['reminder_templates', 'invite_message'],
      });
      expect(result).toBe('updated reminder_templates, invite_message');
    });

    it('fields takes precedence over keys when both are present (if/else-if ordering)', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, {
        fields: ['a'],
        keys: ['b'],
      });
      expect(result).toBe('changed a');
    });

    it('uses singular "participant" when added_count is exactly 1', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED, {
        added_count: 1,
      });
      expect(result).toBe('added 1 participant');
    });

    it('uses plural "participants" when added_count is 0 (grammatically correct, easy off-by-one)', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED, {
        added_count: 0,
      });
      expect(result).toBe('added 0 participants');
    });

    it('uses plural "participants" when added_count is greater than 1', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED, {
        added_count: 5,
      });
      expect(result).toBe('added 5 participants');
    });

    it('falls through to the static description map for a known action with no special metadata', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.DISPUTE_RAISED, null);
      expect(result).toBe('raised a dispute');
    });

    it('falls through to the static map when metadata is an empty object', () => {
      const result = describeAuditAction(AUDIT_ACTIONS.MEMBER_ACCEPTED, {});
      expect(result).toBe('joined the workspace');
    });

    it('falls back to a dot-to-space replacement for an unknown action string', () => {
      const result = describeAuditAction('foo.bar.baz', null);
      expect(result).toBe('foo bar baz');
    });

    it('handles undefined metadata without throwing (optional chaining)', () => {
      expect(() => describeAuditAction(AUDIT_ACTIONS.TASK_CREATED, undefined)).not.toThrow();
      expect(describeAuditAction(AUDIT_ACTIONS.TASK_CREATED, undefined)).toBe('created a task');
    });
  });
});
