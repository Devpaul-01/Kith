const { context, OTHER_ID } = require('./agent-proposal');

const CONTAINER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DISPUTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONTRIBUTOR_ID = OTHER_ID;
const PROPOSAL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = '66666666-6666-4666-8666-666666666666';
const EXECUTION_TIME = '2026-11-17T12:03:00.000Z';
const REVIEWED_TIME = '2026-11-17T12:00:00.000Z';
const REASON = 'The recorded amount does not match my contribution.';
const RESOLUTION_NOTE = 'The payment was checked and the recorded contribution is correct.';

const adminContext = (overrides = {}) => {
  const current = context();
  return { ...current, ...overrides,
    member: { ...current.member, role: 'admin', ...overrides.member },
    workspace: { ...current.workspace, ...overrides.workspace },
  };
};
const adminMember = (overrides = {}) => ({
  id: adminContext().member.id, workspace_id: adminContext().workspace.id,
  user_id: adminContext().userId, role: 'admin', is_active: true, is_proxy: false,
  display_name: 'Adaeze', updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const contributorRow = (overrides = {}) => ({
  id: CONTRIBUTOR_ID, workspace_id: adminContext().workspace.id, user_id: null,
  role: 'member', is_active: true, is_proxy: false, display_name: 'Chidi',
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const workspaceRow = (overrides = {}) => ({
  id: adminContext().workspace.id, name: 'Family', base_currency: 'NGN',
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: adminContext().workspace.id, name: 'Family groceries',
  container_type: 'event', status: 'active', enable_money: true,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const entrySnapshot = (overrides = {}) => ({
  entry_id: ENTRY_ID, workspace_id: adminContext().workspace.id, container_id: CONTAINER_ID,
  contributor_id: CONTRIBUTOR_ID, entry_type: 'contribution', original_amount: '5000.00',
  original_currency: 'NGN', base_amount: '5000.00', payment_method: 'bank_transfer',
  note: 'Family groceries', cycle_id: null, is_crypto: false, status: 'disputed',
  corrects_entry_id: null, recorded_by: CONTRIBUTOR_ID, recorded_at: '2026-11-16T12:01:00.000Z',
  confirmed_at: '2026-11-16T12:02:00.000Z', confirmed_by: adminContext().member.id, ...overrides,
});
const entryRow = (overrides = {}) => {
  const { entry_id: id, ...state } = entrySnapshot();
  return { id, ...state, ...overrides };
};
// Financial/dispute projections are independent of the production state builders.
const disputeSnapshot = (overrides = {}) => ({
  dispute_id: DISPUTE_ID, workspace_id: adminContext().workspace.id, ledger_entry_id: ENTRY_ID,
  raised_by: CONTRIBUTOR_ID, reason: REASON, status: 'open', resolution_note: null,
  resolved_by: null, raised_at: '2026-11-17T11:59:00.000Z', resolved_at: null, ...overrides,
});
const disputeRow = (overrides = {}) => {
  const { dispute_id: id, ...state } = disputeSnapshot();
  return { id, ...state, notes: [], ...overrides };
};
const resolveContext = (overrides = {}) => ({
  workspace_id: adminContext().workspace.id, workspace_name: 'Family', workspace_updated_at: REVIEWED_TIME,
  base_currency: 'NGN', actor_member_id: adminContext().member.id, member_role: 'admin',
  actor_display_name: 'Adaeze', member_updated_at: REVIEWED_TIME,
  container_id: CONTAINER_ID, container_name: 'Family groceries', container_type: 'event',
  container_status: 'active', enable_money: true, container_updated_at: REVIEWED_TIME,
  entry: entrySnapshot(), dispute: disputeSnapshot(), contributor_display_name: 'Chidi',
  contributor_role: 'member', contributor_updated_at: REVIEWED_TIME, ...overrides,
});
const resolveAfter = (overrides = {}) => ({
  dispute: disputeSnapshot({ status: 'resolved', resolution_note: RESOLUTION_NOTE,
    resolved_by: adminContext().member.id, resolved_at: 'on_confirmation' }),
  entry: entrySnapshot({ status: 'resolved' }), ...overrides,
});
const resolveResult = (overrides = {}) => ({
  dispute: disputeSnapshot({ status: 'resolved', resolution_note: RESOLUTION_NOTE,
    resolved_by: adminContext().member.id, resolved_at: EXECUTION_TIME }),
  entry: entrySnapshot({ status: 'resolved' }), ...overrides,
});
const resolvedDispute = (overrides = {}) => disputeRow({
  status: 'resolved', resolution_note: RESOLUTION_NOTE,
  resolved_by: adminContext().member.id, resolved_at: EXECUTION_TIME, ...overrides,
});
const resolvedEntry = (overrides = {}) => entryRow({ status: 'resolved', ...overrides });

module.exports = {
  CONTAINER_ID, ENTRY_ID, DISPUTE_ID, CONTRIBUTOR_ID, PROPOSAL_ID, SESSION_ID, CONVERSATION_ID,
  EXECUTION_TIME, REVIEWED_TIME, REASON, RESOLUTION_NOTE, adminContext, adminMember, contributorRow,
  workspaceRow, containerRow, entrySnapshot, entryRow, disputeSnapshot, disputeRow, resolveContext,
  resolveAfter, resolveResult, resolvedDispute, resolvedEntry,
};
