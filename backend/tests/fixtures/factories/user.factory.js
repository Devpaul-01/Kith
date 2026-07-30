// tests/fixtures/factories/user.factory.js
// Mirrors public.users from schema.txt.

const crypto = require('crypto');

let userCounter = 0;

function buildUser(overrides = {}) {
  userCounter += 1;
  const now = new Date().toISOString();
  const uniqueSuffix = `${userCounter}_${crypto.randomBytes(4).toString('hex')}`;
  return {
    id: overrides.id || crypto.randomUUID(),
    email: overrides.email || `test-user-${uniqueSuffix}@example.test`,
    full_name: `Test User ${userCounter}`,
    bio: null,
    country_of_residence: 'US',
    timezone: 'UTC',
    preferred_language: 'en',
    avatar_url: null,
    auth_provider: 'email',
    push_token: null,
    push_token_platform: null,
    push_enabled: false,
    email_digest_enabled: true,
    created_at: now,
    updated_at: now,
    last_seen_at: null,
    deleted_at: null,
    ...overrides,
  };
}

module.exports = { buildUser };
