const { context, member: baseMember, OTHER_ID } = require('./agent-proposal');

const CONTAINER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DISPUTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROPOSAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const EXECUTION_TIME = '2026-11-16T12:03:00.000Z';
const REVIEWED_TIME = '2026-11-16T12:00:00.000Z';
const REASON = 'The recorded amount does not match my contribution.';
const member = (overrides = {}) => ({
  ...baseMember(), display_name: 'Adaeze', is_proxy: false,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const workspaceRow = (overrides = {}) => ({
  id: context().workspace.id, name: 'Family', base_currency: 'NGN',
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: context().workspace.id, name: 'Family groceries',
  container_type: 'event', status: 'active', enable_money: true,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const entrySnapshot = (overrides = {}) => ({
  entry_id: ENTRY_ID, workspace_id: context().workspace.id, container_id: CONTAINER_ID,
  contributor_id: context().member.id, entry_type: 'contribution', original_amount: '5000.00',
  original_currency: 'NGN', base_amount: '5000.00', payment_method: 'bank_transfer',
  note: 'Family groceries', cycle_id: null, is_crypto: false, status: 'confirmed',
  corrects_entry_id: null, recorded_by: context().member.id, recorded_at: '2026-11-15T12:01:00.000Z',
  confirmed_at: '2026-11-15T12:02:00.000Z', confirmed_by: OTHER_ID, ...overrides,
});
const entryRow = (overrides = {}) => {
  const { entry_id: id, ...state } = entrySnapshot();
  return { id, ...state, ...overrides };
};
const raiseContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, workspace_name: 'Family', workspace_updated_at: REVIEWED_TIME,
  base_currency: 'NGN', actor_member_id: context().member.id, member_role: 'member',
  actor_display_name: 'Adaeze', member_updated_at: REVIEWED_TIME,
  container_id: CONTAINER_ID, container_name: 'Family groceries', container_type: 'event',
  container_status: 'active', enable_money: true, container_updated_at: REVIEWED_TIME,
  entry: entrySnapshot(), dispute: null, ...overrides,
});
// Keep canonical RPC defaults independent of production projection/state helpers.
const plannedDispute = (overrides = {}) => ({
  workspace_id: context().workspace.id, ledger_entry_id: ENTRY_ID, raised_by: context().member.id,
  reason: REASON, status: 'open', resolution_note: null, resolved_by: null, resolved_at: null,
  notes: [], ...overrides,
});
const disputeRow = (overrides = {}) => ({
  id: DISPUTE_ID, ...plannedDispute(), raised_at: EXECUTION_TIME, ...overrides,
});
const raiseAfter = (overrides = {}) => ({
  dispute: { ...plannedDispute(), dispute_id: 'on_confirmation', raised_at: 'on_confirmation' },
  entry: entrySnapshot({ status: 'disputed' }), ...overrides,
});
const raiseResult = (overrides = {}) => ({
  dispute: { ...plannedDispute(), dispute_id: DISPUTE_ID, raised_at: EXECUTION_TIME },
  entry: entrySnapshot({ status: 'disputed' }), ...overrides,
});

module.exports = {
  CONTAINER_ID, ENTRY_ID, DISPUTE_ID, PROPOSAL_ID, SESSION_ID, CONVERSATION_ID, EXECUTION_TIME, REASON,
  context, member, workspaceRow, containerRow, entrySnapshot, entryRow, raiseContext,
  disputeRow, plannedDispute, raiseAfter, raiseResult,
};
