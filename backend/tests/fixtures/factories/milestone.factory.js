// tests/fixtures/factories/milestone.factory.js
// Mirrors public.milestones from schema.txt.

const crypto = require('crypto');

function buildMilestone(overrides = {}) {
  if (!overrides.workspace_id) throw new Error('buildMilestone requires an explicit workspace_id override');
  if (!overrides.created_by) throw new Error('buildMilestone requires an explicit created_by override');

  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    title: 'Test Milestone',
    milestone_date: now.split('T')[0],
    description: null,
    photos: [],
    milestone_type: 'custom',
    created_by: overrides.created_by,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

module.exports = { buildMilestone };
