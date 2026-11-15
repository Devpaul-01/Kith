const { context, member, OTHER_ID } = require('./agent-proposal');
const { CONTAINER_ID, TASK_ID } = require('./agent-task-proposal');

const EXECUTION_TIME = '2026-11-15T12:03:00.000Z';
const adminContext = () => ({ ...context(), member: { ...context().member, role: 'admin' } });
const adminMember = (overrides = {}) => ({
  ...member(), role: 'admin', is_proxy: false, deleted_at: null, ...overrides,
});
const assigneeRow = (overrides = {}) => ({ id: OTHER_ID, workspace_id: context().workspace.id, ...overrides });
const workspaceRow = (overrides = {}) => ({ id: context().workspace.id, deleted_at: null, ...overrides });
const containerRow = (overrides = {}) => ({
  id: CONTAINER_ID, workspace_id: context().workspace.id, name: 'Family errands',
  status: 'active', enable_tasks: true, updated_at: '2026-11-15T12:00:00.000Z',
  deleted_at: null, ...overrides,
});
const proof = (overrides = {}) => ({
  url: `workspaces/${context().workspace.id}/task-proofs/${TASK_ID}/receipt.jpg`,
  name: 'Receipt.jpg', size: 256, mime_type: 'image/jpeg', uploaded_by: OTHER_ID,
  uploaded_at: '2026-11-15T12:01:00.000Z', ...overrides,
});
const taskRow = (overrides = {}) => ({
  id: TASK_ID, container_id: CONTAINER_ID, title: 'Buy groceries',
  description: 'Pick up groceries for dinner', assigned_to: OTHER_ID, due_date: '2026-11-20',
  status: 'completed', completed_at: '2026-11-15T12:02:00.000Z', completed_by: context().member.id,
  completion_note: 'Receipts attached', proofs: [proof()], sort_order: 1,
  created_by: context().member.id, created_at: '2026-11-15T12:00:00.000Z',
  updated_at: '2026-11-15T12:02:00.000Z', deleted_at: null,
  admin_confirmed_at: null, admin_confirmed_by: null, admin_note: 'Check receipt', ...overrides,
});
const confirmationSnapshot = (overrides = {}) => {
  const { id, ...state } = taskRow();
  return { task_id: id, ...state, ...overrides };
};
const confirmationContext = (overrides = {}) => ({
  ...confirmationSnapshot(), workspace_id: context().workspace.id,
  actor_member_id: context().member.id, member_role: 'admin',
  container_name: containerRow().name, container_status: 'active', enable_tasks: true,
  container_updated_at: containerRow().updated_at, ...overrides,
});
const confirmationAfter = (overrides = {}) => confirmationSnapshot({
  admin_confirmed_at: 'on_approval', admin_confirmed_by: context().member.id,
  updated_at: 'on_approval', ...overrides,
});
const confirmationResult = (overrides = {}) => confirmationAfter({
  admin_confirmed_at: EXECUTION_TIME, updated_at: EXECUTION_TIME, ...overrides,
});
const confirmedTask = (overrides = {}) => taskRow({
  admin_confirmed_at: EXECUTION_TIME, admin_confirmed_by: context().member.id,
  updated_at: EXECUTION_TIME, ...overrides,
});

module.exports = {
  CONTAINER_ID, TASK_ID, EXECUTION_TIME, adminContext, adminMember, assigneeRow, workspaceRow,
  containerRow, proof, taskRow, confirmationSnapshot, confirmationContext,
  confirmationAfter, confirmationResult, confirmedTask,
};
