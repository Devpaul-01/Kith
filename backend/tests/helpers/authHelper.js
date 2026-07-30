// tests/helpers/authHelper.js
//
// Two auth-testing needs, two different tools:
//
//   1. UNIT tests (middleware/auth.js in isolation, or any service test
//      that needs a plausible decoded-JWT shape without a real Supabase
//      Auth call): mintTestJWT() builds a JWT-*shaped* token whose
//      payload can be decoded by services/auth.service.js's
//      isRecoverySession() (which only reads the `amr` claim locally,
//      never verifies signature) — this is NOT cryptographically valid
//      and must never be sent to a real Supabase instance.
//
//   2. INTEGRATION tests (full HTTP request through requireAuth, which
//      DOES call supabaseAdmin.auth.getUser(token) for real):
//      mockAuthenticatedRequest() stubs supabaseAdmin.auth.getUser to
//      resolve a fixed { user } payload for a specific bearer token, so
//      requireAuth's real code path runs (including the last_seen_at
//      debounce logic) without needing a real Supabase Auth user to
//      actually exist. This requires the test to hold its own reference
//      to the mocked supabaseAdmin client (see tests/helpers/testApp.js).

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(JSON.stringify(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Builds a JWT-shaped (unsigned, NOT verifiable) token for tests that
 * only need to decode claims locally — e.g.
 * auth.service.js#isRecoverySession, which reads `amr` off the payload
 * segment without ever calling a verification endpoint.
 *
 * @param {string} userId
 * @param {object} overrides - merged into the JWT payload (e.g. { amr: [{ method: 'recovery' }] })
 */
function mintTestJWT(userId, overrides = {}) {
  const header = base64url({ alg: 'none', typ: 'JWT' });
  const payload = base64url({
    sub: userId,
    email: overrides.email || `test-${userId}@example.test`,
    aud: 'authenticated',
    role: 'authenticated',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: overrides.amr || [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
    ...overrides,
  });
  // Signature segment is a random-looking placeholder — never verified
  // by isRecoverySession(), which only base64url-decodes segment [1].
  const signature = crypto.randomBytes(16).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Given a mocked supabaseAdmin client (see tests/mocks/supabase.mock.js
 * or an integration test's real client), configures
 * `client.auth.getUser` to resolve a given user for a specific bearer
 * token, and returns the Authorization header value to send.
 *
 * For UNIT tests of middleware/auth.js or anything downstream of it —
 * pair with a mocked client. For INTEGRATION tests against the real
 * Supabase Auth instance, prefer actually creating a user via
 * client.auth.admin.createUser(...) and signing in for a real token
 * instead of this helper, since requireAuth's real Supabase call needs a
 * real (or realistically stubbed) response either way.
 */
function stubGetUserForToken(mockedSupabaseAuthClient, token, user) {
  mockedSupabaseAuthClient.auth.getUser.mockImplementation((suppliedToken) => {
    if (suppliedToken === token) {
      return Promise.resolve({ data: { user }, error: null });
    }
    return Promise.resolve({ data: { user: null }, error: { message: 'Invalid or expired token', status: 401 } });
  });
  return `Bearer ${token}`;
}

/**
 * Returns a ready-to-use Authorization header string + the bearer token,
 * for tests that don't care about auth mechanics and just need "a valid
 * logged-in user" to attach to a supertest request via
 * .set('Authorization', header).
 */
function bearerHeaderFor(token) {
  return `Bearer ${token}`;
}

// ── mockAuthenticatedRequest ──────────────────────────────────────
//
// Doc 4 Section 2.3 describes this helper ("Returns a supertest agent
// pre-configured with the right Authorization header, for tests that
// don't care about auth mechanics and just need 'a valid logged-in
// admin of workspace X'") but the file as originally sketched only
// stubbed it out as a comment. Implemented here since every route
// integration test file (Doc 3 Section 3) needs this exact wiring and
// duplicating it 15x across route-test files is precisely what Doc 4's
// "shared helper" convention exists to avoid.
//
// WHY THIS SPIES ON THE REAL supabaseAdmin CLIENT (not a jest.mock of
// the whole config/supabase module): integration tests run against a
// REAL Postgres (Doc 3 Section 1) via supabaseAdmin.from(...) calls
// everywhere else in the app — services, middleware/workspace.js, etc.
// We only need to fake the ONE Supabase Auth network call
// (supabaseAdmin.auth.getUser(token)) that requireAuth makes, not the
// whole client. jest.spyOn keeps every other method on the singleton
// untouched and hitting the real test Postgres via PostgREST.
//
// requireAuth (src/middleware/auth.js) sets:
//   req.user = { id: user.id, email: user.email, full_name: user.user_metadata?.full_name }
// so the `user` object handed to supabaseAdmin.auth.getUser's mocked
// resolution must carry at least { id, email, user_metadata }.
//
// This helper does NOT seed a workspace_members row — call
// tests/helpers/dbHelper.js's seedWorkspaceWithAdmin/seedAdditionalMember
// separately and pass the resulting user.id in here. Keeping auth-token
// stubbing and DB seeding as two separate composable steps (rather than
// one mega-helper) matches how the rest of Doc 4's fixtures are designed
// (factories take explicit required overrides, no implicit magic).
//
// Multiple calls against the SAME supabaseAdmin instance (e.g. seeding a
// second actor — an admin AND a non-admin member — in one test file)
// must not clobber each other's token resolution, so registered tokens
// are tracked in a shared Map keyed by token, installed once per
// supabaseAdmin.auth.getUser jest.fn() instance.
//
// PREREQUISITE: supabaseAdmin.auth.getUser must already be a jest mock
// function before this is called — real @supabase/supabase-js clients
// expose getUser as a plain (non-jest) method, so this installs a
// jest.spyOn the first time it's needed rather than requiring every
// test file to remember to do it separately.
function installAuthSpy(supabaseAdmin) {
  if (!jest.isMockFunction(supabaseAdmin.auth.getUser)) {
    jest.spyOn(supabaseAdmin.auth, 'getUser');
  }
  return supabaseAdmin.auth.getUser;
}

function mockAuthenticatedRequest({ supabaseAdmin, userId, email, fullName = null }) {
  installAuthSpy(supabaseAdmin);
  const token = `test-access-token-${userId}`;

  const user = {
    id: userId,
    email: email || `test-${userId}@example.test`,
    user_metadata: fullName ? { full_name: fullName } : {},
  };

  if (!supabaseAdmin.auth.getUser.__mockAuthTokens) {
    supabaseAdmin.auth.getUser.__mockAuthTokens = new Map();
    supabaseAdmin.auth.getUser.mockImplementation((suppliedToken) => {
      const registered = supabaseAdmin.auth.getUser.__mockAuthTokens.get(suppliedToken);
      if (registered) {
        return Promise.resolve({ data: { user: registered }, error: null });
      }
      return Promise.resolve({
        data: { user: null },
        error: { message: 'Invalid or expired token', status: 401 },
      });
    });
  }
  supabaseAdmin.auth.getUser.__mockAuthTokens.set(token, user);

  return {
    userId,
    token,
    authHeader: `Bearer ${token}`,
  };
}

module.exports = {
  mintTestJWT,
  stubGetUserForToken,
  bearerHeaderFor,
  mockAuthenticatedRequest,
  installAuthSpy,
};
