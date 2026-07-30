// tests/fixtures/factories/group.factory.js
// Mirrors public.groups and public.group_members from schema.txt.

const crypto = require('crypto');

let groupCounter = 0;

function buildGroup(overrides = {}) {
  if (!overrides.workspace_id) throw new Error('buildGroup requires an explicit workspace_id override');
  if (!overrides.created_by) throw new Error('buildGroup requires an explicit created_by override');

  groupCounter += 1;
  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    name: `Test Group ${groupCounter}`,
    description: null,
    created_by: overrides.created_by,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildGroupMember(overrides = {}) {
  if (!overrides.group_id) throw new Error('buildGroupMember requires an explicit group_id override');
  if (!overrides.workspace_member_id) throw new Error('buildGroupMember requires an explicit workspace_member_id override');

  return {
    id: overrides.id || crypto.randomUUID(),
    group_id: overrides.group_id,
    workspace_member_id: overrides.workspace_member_id,
    added_at: new Date().toISOString(),
    added_by: overrides.added_by || null,
    ...overrides,
  };
}

module.exports = { buildGroup, buildGroupMember };
