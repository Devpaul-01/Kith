const { context, member } = require('./agent-proposal');

const CONTAINER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ASSIGNEE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTICIPANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EXECUTION_TIME = '2026-11-15T12:03:00.000Z';
const REVIEWED_TIME = '2026-11-15T12:00:00.000Z';
const PARTICIPANT_TIME = '2026-11-15T11:00:00.000Z';
const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({ ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides });
const workspaceRow = (overrides = {}) => ({
  id: context().workspace.id, name: 'Family', updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: context().workspace.id, name: 'Family errands',
  container_type: 'event', status: 'active', enable_tasks: true,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const assigneeRow = (overrides = {}) => ({
  id: ASSIGNEE_ID, workspace_id: context().workspace.id, display_name: 'Chika Okafor',
  role: 'member', user_id: null, is_active: true, is_proxy: false,
  updated_at: REVIEWED_TIME, deleted_at: null, ...overrides,
});
const participantRow = (overrides = {}) => ({
  id: PARTICIPANT_ID, container_id: CONTAINER_ID, workspace_member_id: ASSIGNEE_ID,
  tasks_enabled: true, added_at: PARTICIPANT_TIME, ...overrides,
});
const creationAssignee = (overrides = {}) => ({
  member_id: ASSIGNEE_ID, display_name: 'Chika Okafor', member_role: 'member',
  is_active: true, is_proxy: false, member_updated_at: REVIEWED_TIME,
  participant_id: PARTICIPANT_ID, participant_added_at: PARTICIPANT_TIME, tasks_enabled: true, ...overrides,
});
const creationContext = (overrides = {}) => ({
  workspace_id: context().workspace.id, workspace_name: 'Family', workspace_updated_at: REVIEWED_TIME,
  actor_member_id: context().member.id, member_role: 'admin',
  container_id: CONTAINER_ID, container_name: 'Family errands', container_type: 'event',
  container_status: 'active', enable_tasks: true, container_updated_at: REVIEWED_TIME,
  assignee: null, task: null, ...overrides,
});
const creationData = (overrides = {}) => ({
  title: 'Buy groceries', description: null, assigned_to: null, due_date: null, ...overrides,
});
// Expected stored defaults are independent of the production state builder.
const creationResult = (overrides = {}) => ({
  task_id: TASK_ID, container_id: CONTAINER_ID, ...creationData(), status: 'pending',
  completed_at: null, completed_by: null, completion_note: null, proofs: [], sort_order: 0,
  created_by: context().member.id, created_at: EXECUTION_TIME, updated_at: EXECUTION_TIME,
  deleted_at: null, admin_confirmed_at: null, admin_confirmed_by: null, admin_note: null, ...overrides,
});
const createdTask = (overrides = {}) => {
  const { task_id: id, ...state } = creationResult();
  return { id, ...state, ...overrides };
};
const creationAfter = (overrides = {}) => ({
  ...creationResult(), created_at: 'on_approval', updated_at: 'on_approval', ...overrides,
});

module.exports = {
  CONTAINER_ID, ASSIGNEE_ID, PARTICIPANT_ID, TASK_ID, EXECUTION_TIME, adminContext, adminMember,
  workspaceRow, containerRow, assigneeRow, participantRow, creationAssignee, creationContext,
  creationData, creationAfter, creationResult, createdTask,
};
