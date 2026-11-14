const { context, member } = require('./agent-proposal');

const CONTAINER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({ ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides });
const creationWorkspace = (overrides = {}) => ({
  id: context().workspace.id, name: 'Family', updated_at: '2026-11-14T12:00:00.000Z',
  deleted_at: null, ...overrides,
});
const creationContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, workspace_name: 'Family',
  workspace_updated_at: '2026-11-14T12:00:00.000Z',
  actor_member_id: context().member.id, member_role: 'admin', ...overrides,
});
const creationArguments = (overrides = {}) => ({
  name: 'Family groceries', subtitle: 'November plans', description: 'Shared event',
  enable_money: true, enable_tasks: true, event_date: '2026-12-01',
  event_type: 'Family meeting', event_type_category: 'logistical', ...overrides,
});
const creationData = (overrides = {}) => ({ ...creationArguments(), container_type: 'event', ...overrides });
const creationState = (overrides = {}) => ({
  ...creationData(), container_id: CONTAINER_ID, workspace_id: context().workspace.id,
  created_by: context().member.id, status: 'active', recurrence_cadence: null,
  recurrence_days: null, recurrence_start: null, recurrence_end: null,
  carry_forward_unpaid: false, auto_generate_cycles: true,
  budget_target: null, budget_currency: null, public_token: null, public_show_names: true,
  cover_photos: [], outcome_details: null, outcome_files: [],
  converted_from_id: null, completed_at: null, deleted_at: null, ...overrides,
});
const creationAfter = (overrides = {}) => ({
  ...creationState(), created_at: 'on_approval', updated_at: 'on_approval', ...overrides,
});
const creationResult = (overrides = {}) => ({
  ...creationState(), created_at: '2026-11-14T12:02:00.000Z', updated_at: '2026-11-14T12:02:00.000Z',
  ...overrides,
});
const createdContainer = (overrides = {}) => {
  const { container_id, ...state } = creationResult();
  return { ...state, id: container_id, ...overrides };
};

module.exports = {
  CONTAINER_ID, adminContext, adminMember, creationWorkspace, creationContext,
  creationArguments, creationData, creationState, creationAfter, creationResult, createdContainer,
};
