const { context, member } = require('./agent-proposal');

const CONTAINER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTICIPANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EXECUTION_TIME = '2026-11-15T12:02:00.000Z';
const REVIEWED_TIME = '2026-11-15T12:00:00.000Z';
const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({ ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides });
const workspaceRow = (overrides = {}) => ({
  id: context().workspace.id, name: 'Family', updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: context().workspace.id, name: 'Family meeting',
  container_type: 'event', status: 'active', enable_money: true, enable_tasks: true,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const selectedMemberRow = (overrides = {}) => ({
  id: MEMBER_ID, workspace_id: context().workspace.id, display_name: 'Chika Okafor',
  user_id: null, role: 'member', is_active: true, is_proxy: false,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const additionContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, workspace_name: 'Family', workspace_updated_at: REVIEWED_TIME,
  actor_member_id: context().member.id, member_role: 'admin',
  container_id: CONTAINER_ID, container_name: 'Family meeting', container_type: 'event',
  container_status: 'active', enable_money: true, enable_tasks: true, container_updated_at: REVIEWED_TIME,
  workspace_member_id: MEMBER_ID, display_name: 'Chika Okafor', selected_member_role: 'member',
  selected_member_active: true, selected_member_proxy: false, selected_member_updated_at: REVIEWED_TIME,
  participant: null, ...overrides,
});
const additionData = (overrides = {}) => ({
  workspace_member_id: MEMBER_ID, money_enabled: false, tasks_enabled: false, ...overrides,
});
// Independent schema fixture: keep expected stored defaults separate from the production builder.
const additionResult = (overrides = {}) => ({
  participant_id: PARTICIPANT_ID, container_id: CONTAINER_ID, workspace_member_id: MEMBER_ID,
  money_enabled: false, tasks_enabled: false, role: null, notes: null,
  exclude_from_public: false, added_by: context().member.id, added_at: EXECUTION_TIME, ...overrides,
});
const participantRow = (overrides = {}) => {
  const { participant_id: id, ...state } = additionResult();
  return { id, ...state, ...overrides };
};
const additionAfter = (overrides = {}) => ({ ...additionResult(), added_at: 'on_approval', ...overrides });

module.exports = {
  CONTAINER_ID, MEMBER_ID, PARTICIPANT_ID, EXECUTION_TIME, adminContext, adminMember,
  workspaceRow, containerRow, selectedMemberRow, additionContext, additionData,
  participantRow, additionAfter, additionResult,
};
