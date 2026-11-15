const { context, member } = require('./agent-proposal');

const MEMBER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({ ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides });
const creationWorkspace = (overrides = {}) => ({
  id: context().workspace.id, name: 'Family', updated_at: '2026-11-15T12:00:00.000Z',
  deleted_at: null, ...overrides,
});
const creationContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, workspace_name: 'Family',
  workspace_updated_at: '2026-11-15T12:00:00.000Z',
  actor_member_id: context().member.id, member_role: 'admin', ...overrides,
});
const creationArguments = (overrides = {}) => ({
  display_name: 'Chika Okafor', is_proxy: false, relationship_to_head: 'Cousin',
  relationship_category: 'blood', date_of_birth: '1990-04-10', admin_notes: 'Added at the family meeting',
  ...overrides,
});
const creationData = (overrides = {}) => creationArguments(overrides);
const creationState = (overrides = {}) => ({
  ...creationData(), member_id: MEMBER_ID, workspace_id: context().workspace.id,
  user_id: null, role: 'member', proxy_managed_by: overrides.is_proxy ? context().member.id : null,
  invite_status: null, invited_at: null, last_active_at: null,
  contribution_streak_months: 0, last_contribution_date: null, is_active: true, deleted_at: null,
  ...overrides,
});
const creationAfter = (overrides = {}) => ({
  ...creationState(overrides), joined_at: 'on_approval', created_at: 'on_approval', updated_at: 'on_approval',
  ...overrides,
});
const creationResult = (overrides = {}) => ({
  ...creationState(overrides), joined_at: '2026-11-15T12:02:00.000Z',
  created_at: '2026-11-15T12:02:00.000Z', updated_at: '2026-11-15T12:02:00.000Z',
  ...overrides,
});
const createdMember = (overrides = {}) => {
  const { member_id, ...state } = creationResult(overrides);
  return { ...state, id: member_id, ...overrides };
};

module.exports = {
  MEMBER_ID, adminContext, adminMember, creationWorkspace, creationContext,
  creationArguments, creationData, creationState, creationAfter, creationResult, createdMember,
};
