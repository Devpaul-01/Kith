// tests/fixtures/factories/task.factory.js
// Mirrors public.container_tasks from schema.txt.

const crypto = require('crypto');

function buildTask(overrides = {}) {
  if (!overrides.container_id) throw new Error('buildTask requires an explicit container_id override');
  if (!overrides.created_by) throw new Error('buildTask requires an explicit created_by override');

  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    container_id: overrides.container_id,
    title: 'Test Task',
    description: null,
    assigned_to: overrides.assigned_to !== undefined ? overrides.assigned_to : null,
    due_date: null,
    status: 'pending',
    completed_at: null,
    completed_by: null,
    completion_note: null,
    proofs: [],
    sort_order: 0,
    created_by: overrides.created_by,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    admin_confirmed_at: null,
    admin_confirmed_by: null,
    admin_note: null,
    ...overrides,
  };
}

module.exports = { buildTask };
