// tests/fixtures/factories/member.factory.js
// Mirrors public.workspace_members from schema.txt.
//
// workspace_id is a REQUIRED override (no default) — Doc 4 Section 2.1's
// rule for entities with relationships: force the test to be explicit
// about the FK rather than accidentally testing against a
// dangling/fake workspace_id.

const crypto = require('crypto');

let memberCounter = 0;

function buildMember(overrides = {}) {
  if (!overrides.workspace_id) {
    throw new Error('buildMember requires an explicit workspace_id override');
  }

  memberCounter += 1;
  const now = new Date().toISOString();

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    user_id: overrides.user_id !== undefined ? overrides.user_id : crypto.randomUUID(),
    role: 'member',
    display_name: `Test Member ${memberCounter}`,
    relationship_to_head: null,
    relationship_category: 'other',
    date_of_birth: null,
    is_proxy: false,
    proxy_managed_by: null,
    admin_notes: null,
    invite_status: 'accepted',
    invited_at: null,
    joined_at: now,
    last_active_at: null,
    contribution_streak_months: 0,
    last_contribution_date: null,
    is_active: true,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

/** Convenience: an admin member, since so many tests need one. */
function buildAdminMember(overrides = {}) {
  return buildMember({ role: 'admin', ...overrides });
}

/** Convenience: a proxy member (elderly relative, child, etc. with no login). */
function buildProxyMember(overrides = {}) {
  return buildMember({ is_proxy: true, user_id: null, invite_status: null, ...overrides });
}

module.exports = { buildMember, buildAdminMember, buildProxyMember };
