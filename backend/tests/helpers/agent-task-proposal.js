const { context } = require('./agent-proposal');

const CONTAINER_ID = '77777777-7777-4777-8777-777777777777';
const TASK_ID = '88888888-8888-4888-8888-888888888888';
const selectedTask = () => ({ container_id: CONTAINER_ID, task_id: TASK_ID });
const taskSnapshot = () => ({
  id: TASK_ID, container_id: CONTAINER_ID, title: 'Buy groceries',
  assigned_to: context().member.id, status: 'pending', completion_note: null,
  completed_at: null, completed_by: null, admin_confirmed_at: null,
  updated_at: '2026-11-13T12:00:00.000Z',
});
const taskRow = (overrides = {}) => ({
  ...taskSnapshot(), description: 'Pick up groceries for dinner', deleted_at: null,
  proofs: [{ id: '99999999-9999-4999-8999-999999999999', storage_path: 'PRIVATE_PROOF_PATH' }],
  admin_note: 'PRIVATE_ADMIN_NOTE', ...overrides,
});
const updatedTask = (data = { status: 'completed', completion_note: 'Done' }) => taskRow({
  ...data, updated_at: '2026-11-13T12:01:00.000Z',
  ...(data.status === 'completed' ? {
    completed_at: '2026-11-13T12:01:00.000Z', completed_by: context().member.id,
  } : {}),
});

module.exports = { CONTAINER_ID, TASK_ID, selectedTask, taskSnapshot, taskRow, updatedTask };
