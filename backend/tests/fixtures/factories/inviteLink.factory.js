// tests/fixtures/factories/inviteLink.factory.js
// Mirrors public.invite_links from schema.txt.

const crypto = require('crypto');

function buildInviteLink(overrides = {}) {
  if (!overrides.workspace_id) throw new Error('buildInviteLink requires an explicit workspace_id override');
  if (!overrides.created_by) throw new Error('buildInviteLink requires an explicit created_by override');

  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    id: overrides.id || crypto.randomUUID(),
    workspace_id: overrides.workspace_id,
    token: overrides.token || crypto.randomBytes(24).toString('hex'),
    created_by: overrides.created_by,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    used_at: null,
    used_by_user_id: null,
    ...overrides,
  };
}

/** Convenience: an already-expired invite, for negative-path tests. */
function buildExpiredInviteLink(overrides = {}) {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  return buildInviteLink({ expires_at: past, ...overrides });
}

/** Convenience: an already-used invite, for negative-path tests. */
function buildUsedInviteLink(overrides = {}) {
  return buildInviteLink({
    used_at: new Date().toISOString(),
    used_by_user_id: overrides.used_by_user_id || crypto.randomUUID(),
    ...overrides,
  });
}

module.exports = { buildInviteLink, buildExpiredInviteLink, buildUsedInviteLink };
