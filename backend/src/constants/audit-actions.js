// src/constants/audit-actions.js
//
// Issue M3 / N5 fix: audit action strings like 'container.completed',
// 'ledger.confirmed', 'dispute.raised' were previously hardcoded as string
// literals scattered across container.controller.js, dispute.controller.js,
// ledger.controller.js, invite.controller.js, workspace.controller.js,
// participant.controller.js, and member.controller.js — while
// workspace.controller.js separately maintained a hand-synced lookup table
// (getActivityDescription's `actions` object) that had to be kept in
// lockstep with every one of those literals by hand. A typo in either place
// (e.g. 'container.compelted') would fail silently: getActivityDescription
// just falls through to its generic fallback with no error and no test to
// catch it.
//
// Now: one frozen enum-like object is the single source of truth. Every
// `audit.log({ action: ... })` call site imports AUDIT_ACTIONS instead of
// typing the string, and the human-readable description map lives right
// next to it so the two can never drift out of sync.

const AUDIT_ACTIONS = Object.freeze({
  // Containers
  CONTAINER_COMPLETED:              'container.completed',
  CONTAINER_ARCHIVED:               'container.archived',
  CONTAINER_DELETED:                'container.deleted',
  CONTAINER_RESTORED:               'container.restored',
  CONTAINER_SETTINGS_CHANGED:       'container.settings_changed',
  CONTAINER_PARTICIPANTS_ADDED:     'container.participants_added',
  CONTAINER_CONVERTED_TO_RECURRING: 'container.converted_to_recurring',

  // Ledger
  LEDGER_CONFIRMED: 'ledger.confirmed',
  LEDGER_SUBMITTED: 'ledger.submitted',
  LEDGER_CORRECTED: 'ledger.corrected',
  LEDGER_DELETED:   'ledger.deleted',

  // Disputes
  DISPUTE_RAISED:   'dispute.raised',
  DISPUTE_RESOLVED: 'dispute.resolved',

  // Workspace
  WORKSPACE_SETTINGS_CHANGED:  'workspace.settings_changed',
  WORKSPACE_DELETED:           'workspace.deleted',
  WORKSPACE_ANNOUNCEMENT_SENT: 'workspace.announcement_sent',

  // Members
  MEMBER_INVITED:  'member.invited',
  MEMBER_ACCEPTED: 'member.accepted',
  MEMBER_REMOVED:  'member.removed',

  // Cycles
  CYCLE_OVERRIDE_APPLIED: 'cycle.override_applied',

  // Tasks
  TASK_CREATED:   'task.created',
  TASK_COMPLETED: 'task.completed',
  TASK_CONFIRMED: 'task.confirmed',
});

// Human-readable description used by workspace.controller.js's activity
// feed. Kept in the same file as the actions themselves so they cannot
// drift out of sync the way two separately-maintained lists could.
const AUDIT_ACTION_DESCRIPTIONS = Object.freeze({
  [AUDIT_ACTIONS.CONTAINER_COMPLETED]:              'completed a container',
  [AUDIT_ACTIONS.CONTAINER_ARCHIVED]:               'archived a container',
  [AUDIT_ACTIONS.CONTAINER_DELETED]:                'deleted a container',
  [AUDIT_ACTIONS.CONTAINER_RESTORED]:               'restored a container',
  [AUDIT_ACTIONS.CONTAINER_SETTINGS_CHANGED]:       'updated container settings',
  [AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED]:     'added participants to a container',
  [AUDIT_ACTIONS.CONTAINER_CONVERTED_TO_RECURRING]: 'converted event to recurring pool',
  [AUDIT_ACTIONS.LEDGER_CONFIRMED]:                 'confirmed a contribution',
  [AUDIT_ACTIONS.LEDGER_SUBMITTED]:                 'submitted a contribution',
  [AUDIT_ACTIONS.LEDGER_CORRECTED]:                 'added a correction',
  [AUDIT_ACTIONS.LEDGER_DELETED]:                   'deleted a ledger entry',
  [AUDIT_ACTIONS.DISPUTE_RAISED]:                   'raised a dispute',
  [AUDIT_ACTIONS.DISPUTE_RESOLVED]:                 'resolved a dispute',
  [AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED]:       'updated workspace settings',
  [AUDIT_ACTIONS.WORKSPACE_DELETED]:                'deleted workspace',
  [AUDIT_ACTIONS.WORKSPACE_ANNOUNCEMENT_SENT]:      'sent an announcement',
  [AUDIT_ACTIONS.MEMBER_INVITED]:                   'invited a new member',
  [AUDIT_ACTIONS.MEMBER_ACCEPTED]:                  'joined the workspace',
  [AUDIT_ACTIONS.MEMBER_REMOVED]:                   'removed a member',
  [AUDIT_ACTIONS.CYCLE_OVERRIDE_APPLIED]:           'applied cycle override',
  [AUDIT_ACTIONS.TASK_CREATED]:                     'created a task',
  [AUDIT_ACTIONS.TASK_COMPLETED]:                   'completed a task',
  [AUDIT_ACTIONS.TASK_CONFIRMED]:                   'confirmed a task',
});

/**
 * Human-readable description for an audit action, with the same
 * metadata-aware overrides workspace.controller.js's getActivityDescription
 * previously implemented inline.
 */
function describeAuditAction(action, metadata) {
  if (metadata?.fields?.length) return `changed ${metadata.fields.join(', ')}`;
  if (metadata?.keys?.length)   return `updated ${metadata.keys.join(', ')}`;
  if (metadata?.added_count !== undefined) {
    const s = metadata.added_count !== 1 ? 's' : '';
    return `added ${metadata.added_count} participant${s}`;
  }
  return AUDIT_ACTION_DESCRIPTIONS[action] || action.replace(/\./g, ' ');
}

module.exports = { AUDIT_ACTIONS, AUDIT_ACTION_DESCRIPTIONS, describeAuditAction };
