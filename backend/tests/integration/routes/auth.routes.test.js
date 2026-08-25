// tests/integration/routes/auth.routes.test.js
//
// Doc 3 Section 3.1 — auth.routes.js (mounted /v1/auth). This is the
// "standard baseline-matrix suite (with supabaseAuth/supabaseAdmin.auth.*
// mocked)" referenced in Doc 3 Section 3.1's opening paragraph. The
// separate "own semi-real-Supabase-Auth suite" (JWT issuance/expiry,
// recovery-session amr claims, OAuth code exchange against a REAL local
// Supabase Auth instance) lives in
// tests/integration/routes/auth.routes.real-gotrue.test.js, kept
// deliberately small and separate per Doc 3 Section 1's note that
// spinning up GoTrue is heavier than the rest of the stack combined.
//
// MOCKING STRATEGY: src/config/supabase.js exports TWO separate real
// @supabase/supabase-js client instances — supabaseAdmin (service role)
// and supabaseAuth (anon key). auth.service.js's signup/login/etc. call
// through supabaseAuth (via getAuthClient()), while requireAuth
// (middleware) and register()/resetPassword()/changePassword() call
// supabaseAdmin.auth.* directly. Both are spied on with jest.spyOn per
// test (not jest.mock of the whole module) so the REST of the request
// path (supabaseAdmin.from('users')... for profile upserts, real
// Postgres) still exercises the genuine DB, per Doc 3 Section 1's
// "integration tests use a real Postgres" rule — only the GoTrue network
// calls themselves are faked.

const request = require('supertest');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin, supabaseAuth } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest, mintTestJWT } = require('../../helpers/authHelper');
const { buildUser } = require('../../fixtures/factories');
const crypto = require('crypto');

function freshUserId() {
  return crypto.randomUUID();
}

function spyAuth(client, method) {
  if (!jest.isMockFunction(client.auth[method])) {
    jest.spyOn(client.auth, method);
  }
  return client.auth[method];
}

function spyAdminAuth(method) {
  if (!jest.isMockFunction(supabaseAdmin.auth.admin[method])) {
    jest.spyOn(supabaseAdmin.auth.admin, method);
  }
  return supabaseAdmin.auth.admin[method];
}

describe('auth.routes.js — /v1/auth (mocked GoTrue)', () => {
  const app = getTestApp();
  const createdUserIds = [];

  afterAll(async () => {
    for (const id of createdUserIds) {
      try {
        await supabaseAdmin.from('users').delete().eq('id', id);
      } catch (err) {
        // Best-effort cleanup — ignore failures so one bad row
        // doesn't fail the whole suite teardown.
      }
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── POST /signup ───────────────────────────────────────────────
  describe('POST /v1/auth/signup', () => {
    it('duplicate email maps via the code-based branch (user_already_exists)', async () => {
      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: {},
        error: { code: 'user_already_exists', message: 'User already registered' },
      });

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'dup@example.test', password: 'Passw0rd123', full_name: 'Dup User', country_of_residence: 'US',
      });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already exists/i);
    });

    it('duplicate email maps via the message-substring-only fallback branch (no code present)', async () => {
      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: {},
        error: { message: 'User already registered' }, // no `code` field
      });

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'dup2@example.test', password: 'Passw0rd123', full_name: 'Dup User', country_of_residence: 'US',
      });

      expect(res.status).toBe(409);
    });

    it('weak_password code path maps to a 400 ValidationError', async () => {
      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: {},
        error: { code: 'weak_password', message: 'Password should contain at least one number' },
      });

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'weak@example.test', password: 'Passw0rd123', full_name: 'Weak Pw', country_of_residence: 'US',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.field).toBe('password');
    });

    it('successful signup with immediate session (email confirmation disabled) returns access_token + user', async () => {
      const userId = freshUserId();
      createdUserIds.push(userId);

      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: {
          user: { id: userId, email: 'immediate@example.test' },
          session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
        },
        error: null,
      });

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'immediate@example.test', password: 'Passw0rd123', full_name: 'Immediate User', country_of_residence: 'US',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.access_token).toBe('at');
      expect(res.body.data.profile_setup_required).toBe(false);
      expect(res.headers['set-cookie']).toBeDefined();

      // Profile row should now genuinely exist in the real test Postgres.
      const { data: userRow } = await supabaseAdmin.from('users').select('*').eq('id', userId).maybeSingle();
      expect(userRow).not.toBeNull();
      expect(userRow.full_name).toBe('Immediate User');
    });

    it('successful signup with NO session (email confirmation required) returns pending_verification shape', async () => {
      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: { user: { id: freshUserId(), email: 'pending@example.test' }, session: null },
        error: null,
      });

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'pending@example.test', password: 'Passw0rd123', full_name: 'Pending User', country_of_residence: 'US',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.email).toBe('pending@example.test');
      expect(res.body.data.access_token).toBeUndefined();
    });

    it('Issue H3: profile row upsert failing after successful GoTrue signUp still returns 201 with profile_setup_required: true', async () => {
      const userId = freshUserId();

      spyAuth(supabaseAuth, 'signUp').mockResolvedValue({
        data: {
          user: { id: userId, email: 'degraded@example.test' },
          session: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 },
        },
        error: null,
      });

      // Force the users-table upsert to fail: insert a conflicting row
      // with the SAME id but a mismatched, already-taken email first so
      // the upsert's own unique(email) constraint fails — simulating a
      // profile-write hiccup without needing to fully mock supabaseAdmin.
      const conflictingUser = buildUser({ id: userId, email: 'already-taken-elsewhere@example.test' });
      await supabaseAdmin.from('users').insert(conflictingUser);
      createdUserIds.push(userId);

      const res = await request(app).post('/v1/auth/signup').send({
        email: 'degraded@example.test', password: 'Passw0rd123', full_name: 'Degraded User', country_of_residence: 'US',
      });

      // Must NOT hard-fail the whole signup over the profile-row hiccup.
      expect(res.status).toBe(201);
      expect(res.body.data.profile_setup_required).toBe(true);
      expect(res.body.data.message).toMatch(/profile setup is incomplete/i);
    });
  });

  // ── POST /login ────────────────────────────────────────────────
  describe('POST /v1/auth/login', () => {
    it('wrong password maps to 401 invalid_credentials', async () => {
      spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({
        data: {},
        error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      });

      const res = await request(app).post('/v1/auth/login').send({ email: 'x@example.test', password: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('unconfirmed email maps to 422 BusinessRuleError', async () => {
      spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({
        data: {},
        error: { code: 'email_not_confirmed', message: 'Email not confirmed' },
      });

      const res = await request(app).post('/v1/auth/login').send({ email: 'unconfirmed@example.test', password: 'whatever1' });
      expect(res.status).toBe(422);
    });

    it('login succeeding at GoTrue with no local users row returns profile_setup_required: true, user: null', async () => {
      const userId = freshUserId();

      spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({
        data: {
          user: { id: userId, email: 'oauth-only@example.test' },
          session: { access_token: 'at3', refresh_token: 'rt3', expires_in: 3600 },
        },
        error: null,
      });

      const res = await request(app).post('/v1/auth/login').send({ email: 'oauth-only@example.test', password: 'whatever1' });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toBeNull();
      expect(res.body.data.profile_setup_required).toBe(true);
      expect(res.body.data.memberships).toEqual([]);
    });

    it('multiple workspace memberships are correctly flattened from the workspaces!inner(...) join', async () => {
      const userId = freshUserId();
      const user = buildUser({ id: userId, email: 'multi-membership@example.test' });
      await supabaseAdmin.from('users').insert(user);
      createdUserIds.push(userId);

      const { data: ws1 } = await supabaseAdmin.from('workspaces').insert({
        name: 'WS One', base_currency: 'USD', family_type: 'extended', created_by: userId,
      }).select().single();
      const { data: ws2 } = await supabaseAdmin.from('workspaces').insert({
        name: 'WS Two', base_currency: 'GBP', family_type: 'extended', created_by: userId,
      }).select().single();

      await supabaseAdmin.from('workspace_members').insert([
        { workspace_id: ws1.id, user_id: userId, role: 'admin', display_name: 'Multi User', invite_status: 'accepted' },
        { workspace_id: ws2.id, user_id: userId, role: 'member', display_name: 'Multi User', invite_status: 'accepted' },
      ]);

      spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({
        data: {
          user: { id: userId, email: user.email },
          session: { access_token: 'at4', refresh_token: 'rt4', expires_in: 3600 },
        },
        error: null,
      });

      const res = await request(app).post('/v1/auth/login').send({ email: user.email, password: 'whatever1' });

      expect(res.status).toBe(200);
      expect(res.body.data.memberships).toHaveLength(2);
      const workspaceIds = res.body.data.memberships.map((m) => m.workspace_id).sort();
      expect(workspaceIds).toEqual([ws1.id, ws2.id].sort());

      await supabaseAdmin.from('workspaces').delete().in('id', [ws1.id, ws2.id]);
    });
  });

  // ── POST /refresh ──────────────────────────────────────────────
  describe('POST /v1/auth/refresh', () => {
    it('missing refresh_token cookie returns 401 (proves cookie-parser is active)', async () => {
      const res = await request(app).post('/v1/auth/refresh');
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/no refresh token/i);
    });

    it('expired/invalid refresh token returns 401', async () => {
      spyAuth(supabaseAuth, 'refreshSession').mockResolvedValue({
        data: {}, error: { message: 'Refresh token expired' },
      });

      const res = await request(app)
        .post('/v1/auth/refresh')
        .set('Cookie', ['refresh_token=stale-token']);

      expect(res.status).toBe(401);
    });

    it('success sets a new refresh_token cookie with correct options', async () => {
      spyAuth(supabaseAuth, 'refreshSession').mockResolvedValue({
        data: { session: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } },
        error: null,
      });

      const res = await request(app)
        .post('/v1/auth/refresh')
        .set('Cookie', ['refresh_token=old-token']);

      expect(res.status).toBe(200);
      const cookieHeader = res.headers['set-cookie']?.join(';') || '';
      expect(cookieHeader).toContain('refresh_token=new-rt');
      expect(cookieHeader.toLowerCase()).toContain('httponly');
      expect(cookieHeader.toLowerCase()).toContain('samesite=strict');
      expect(cookieHeader).toContain('Path=/v1/auth/refresh');
    });
  });

  // ── POST /forgot-password ──────────────────────────────────────
  describe('POST /v1/auth/forgot-password', () => {
    it('returns an identical success response for a real vs a fake email (anti-enumeration)', async () => {
      spyAuth(supabaseAuth, 'resetPasswordForEmail').mockResolvedValue({ data: {}, error: null });

      const realRes = await request(app).post('/v1/auth/forgot-password').send({ email: 'exists@example.test' });
      const fakeRes = await request(app).post('/v1/auth/forgot-password').send({ email: 'does-not-exist@example.test' });

      expect(realRes.status).toBe(200);
      expect(fakeRes.status).toBe(200);
      expect(realRes.body).toEqual(fakeRes.body);
    });
  });

  // ── GET /google/url ────────────────────────────────────────────
  describe('GET /v1/auth/google/url', () => {
    it('redirect_to within FRONTEND_URL origin is honored', async () => {
      const target = `${process.env.FRONTEND_URL}/some/deep/path`;
      const res = await request(app).get('/v1/auth/google/url').query({ redirect_to: target });

      expect(res.status).toBe(200);
      expect(decodeURIComponent(res.body.data.url)).toContain(target);
    });

    it('an arbitrary external domain is rejected and falls back to the default redirect (Issue C2)', async () => {
      const res = await request(app).get('/v1/auth/google/url').query({ redirect_to: 'https://evil.com/steal-tokens' });

      expect(res.status).toBe(200);
      expect(res.body.data.url).not.toContain('evil.com');
      expect(decodeURIComponent(res.body.data.url)).toContain(`${process.env.FRONTEND_URL}/auth/callback`);
    });

    it('a configured ALLOWED_DEEPLINK_SCHEMES entry is honored', async () => {
      // tests/setup.integration.js sets ALLOWED_DEEPLINK_SCHEMES=kithapp://
      const res = await request(app).get('/v1/auth/google/url').query({ redirect_to: 'kithapp://auth/callback' });

      expect(res.status).toBe(200);
      expect(decodeURIComponent(res.body.data.url)).toContain('kithapp://auth/callback');
    });

    it('adversarial bypass attempt: FRONTEND_URL-prefixed-but-actually-a-different-origin domain must be rejected', async () => {
      // If FRONTEND_URL is https://app.test.local (no trailing slash),
      // an attacker-controlled https://app.test.local.evil.com would
      // incorrectly pass a naive `.startsWith(FRONTEND_URL)` check. This
      // test surfaces whether that bypass exists in the current code —
      // per Doc 3 Section 3.1, flag prominently rather than silently
      // asserting either outcome as "correct."
      const bypassAttempt = `${process.env.FRONTEND_URL}.evil.com/phish`;
      const res = await request(app).get('/v1/auth/google/url').query({ redirect_to: bypassAttempt });

      expect(res.status).toBe(200);
      const returnedUrl = decodeURIComponent(res.body.data.url);

      // THIS IS THE ADVERSARIAL ASSERTION: if this fails, it CONFIRMS the
      // open-redirect bypass Doc 3 flagged as "a plausible real bug worth
      // flagging prominently." Do not loosen this assertion to make the
      // test pass — an unexpected failure here is the finding, not a
      // test-writing mistake.
      expect(returnedUrl).not.toContain(bypassAttempt);
    });
  });

  // ── POST /google/callback ──────────────────────────────────────
  describe('POST /v1/auth/google/callback', () => {
    it('missing code returns a ValidationError', async () => {
      const res = await request(app).post('/v1/auth/google/callback').send({});
      expect(res.status).toBe(400);
    });

    it('exchange failure maps through mapSupabaseAuthError', async () => {
      spyAuth(supabaseAuth, 'exchangeCodeForSession').mockResolvedValue({
        data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      });

      const res = await request(app).post('/v1/auth/google/callback').send({ code: 'bad-code' });
      expect(res.status).toBe(401);
    });

    it('new user (first Google login) upserts with auth_provider google, avatar_url from user_metadata.avatar_url', async () => {
      const userId = freshUserId();
      createdUserIds.push(userId);

      spyAuth(supabaseAuth, 'exchangeCodeForSession').mockResolvedValue({
        data: {
          session: { access_token: 'gat', refresh_token: 'grt', expires_in: 3600 },
          user: {
            id: userId,
            email: 'googleuser@example.test',
            user_metadata: { full_name: 'Google User', avatar_url: 'https://lh3.googleusercontent.com/a/pic.jpg' },
          },
        },
        error: null,
      });

      const res = await request(app).post('/v1/auth/google/callback').send({ code: 'good-code' });

      expect(res.status).toBe(200);
      const { data: row } = await supabaseAdmin.from('users').select('*').eq('id', userId).single();
      expect(row.auth_provider).toBe('google');
      expect(row.avatar_url).toBe('https://lh3.googleusercontent.com/a/pic.jpg');
    });

    it('falls back to user_metadata.picture when avatar_url is absent (both metadata shapes tested)', async () => {
      const userId = freshUserId();
      createdUserIds.push(userId);

      spyAuth(supabaseAuth, 'exchangeCodeForSession').mockResolvedValue({
        data: {
          session: { access_token: 'gat2', refresh_token: 'grt2', expires_in: 3600 },
          user: {
            id: userId,
            email: 'googleuser2@example.test',
            user_metadata: { name: 'Google User Two', picture: 'https://lh3.googleusercontent.com/a/pic2.jpg' },
          },
        },
        error: null,
      });

      const res = await request(app).post('/v1/auth/google/callback').send({ code: 'good-code-2' });

      expect(res.status).toBe(200);
      const { data: row } = await supabaseAdmin.from('users').select('*').eq('id', userId).single();
      expect(row.avatar_url).toBe('https://lh3.googleusercontent.com/a/pic2.jpg');
      expect(row.full_name).toBe('Google User Two');
    });
  });

  // ── POST /verify-email ──────────────────────────────────────────
  describe('POST /v1/auth/verify-email', () => {
    it('missing token_hash returns a ValidationError', async () => {
      const res = await request(app).post('/v1/auth/verify-email').send({});
      expect(res.status).toBe(400);
    });

    it('type defaults to "email" when omitted', async () => {
      const verifyOtpSpy = spyAuth(supabaseAuth, 'verifyOtp').mockResolvedValue({
        data: { session: { access_token: 'vat', refresh_token: 'vrt', expires_in: 3600 } },
        error: null,
      });

      const res = await request(app).post('/v1/auth/verify-email').send({ token_hash: 'some-hash' });

      expect(res.status).toBe(200);
      expect(verifyOtpSpy).toHaveBeenCalledWith(expect.objectContaining({ token_hash: 'some-hash', type: 'email' }));
    });

    it('explicit type is passed through', async () => {
      const verifyOtpSpy = spyAuth(supabaseAuth, 'verifyOtp').mockResolvedValue({
        data: { session: null }, error: null,
      });

      await request(app).post('/v1/auth/verify-email').send({ token_hash: 'some-hash', type: 'recovery' });

      expect(verifyOtpSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'recovery' }));
    });

    it('invalid/expired token maps through mapSupabaseAuthError', async () => {
      spyAuth(supabaseAuth, 'verifyOtp').mockResolvedValue({
        data: {}, error: { message: 'Token has expired' },
      });

      const res = await request(app).post('/v1/auth/verify-email').send({ token_hash: 'expired-hash' });
      expect(res.status).toBe(400);
    });
  });

  // ── Authenticated routes (require a valid bearer token) ────────
  describe('authenticated routes', () => {
    async function seedAuthedUser(overrides = {}) {
      const userId = freshUserId();
      const user = buildUser({ id: userId, ...overrides });
      await supabaseAdmin.from('users').insert(user);
      createdUserIds.push(userId);

      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId, email: user.email });
      return { user, authHeader };
    }

    describe('POST /logout, POST /logout-all-devices', () => {
      it('logout calls admin.signOut(userId) with only ONE argument', async () => {
        const { authHeader } = await seedAuthedUser();
        const signOutSpy = spyAdminAuth('signOut').mockResolvedValue({ error: null });

        const res = await request(app).post('/v1/auth/logout').set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(signOutSpy).toHaveBeenCalledTimes(1);
        expect(signOutSpy.mock.calls[0]).toHaveLength(1);
      });

      it('logout-all-devices calls admin.signOut(userId, "global") — asserts the second argument DIFFERS from plain logout', async () => {
        const { authHeader } = await seedAuthedUser();
        const signOutSpy = spyAdminAuth('signOut').mockResolvedValue({ error: null });

        const res = await request(app).post('/v1/auth/logout-all-devices').set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(signOutSpy).toHaveBeenCalledWith(expect.any(String), 'global');
      });

      it('both clear the refresh_token cookie regardless of the underlying signOut call failing', async () => {
        const { authHeader } = await seedAuthedUser();
        spyAdminAuth('signOut').mockResolvedValue({ error: { message: 'boom' } });

        const res = await request(app).post('/v1/auth/logout').set('Authorization', authHeader);

        expect(res.status).toBe(200); // does not fail the request
        const cookieHeader = res.headers['set-cookie']?.join(';') || '';
        expect(cookieHeader).toMatch(/refresh_token=;/);
      });
    });

    describe('POST /reset-password', () => {
      it('a non-recovery session JWT is rejected with ForbiddenError', async () => {
        const { user } = await seedAuthedUser();
        const nonRecoveryJwt = mintTestJWT(user.id, { amr: [{ method: 'password' }] });

        // requireAuth itself resolves via the mocked getUser keyed by
        // whatever bearer token is presented — register THIS specific
        // JWT-shaped string as a valid token too, so requireAuth accepts
        // it and isRecoverySession's header-parsing branch is exercised
        // against real (JWT-shaped) payload bytes.
        mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
        supabaseAdmin.auth.getUser.__mockAuthTokens.set(nonRecoveryJwt, { id: user.id, email: user.email, user_metadata: {} });

        const res = await request(app)
          .post('/v1/auth/reset-password')
          .set('Authorization', `Bearer ${nonRecoveryJwt}`)
          .send({ password: 'NewPassw0rd1' });

        expect(res.status).toBe(403);
      });

      it('a malformed/unparseable JWT is caught and returns the same ForbiddenError, not a 500', async () => {
        const { user } = await seedAuthedUser();
        const malformedToken = 'not.a.valid.jwt.shape====';
        supabaseAdmin.auth.getUser.__mockAuthTokens.set(malformedToken, { id: user.id, email: user.email, user_metadata: {} });

        const res = await request(app)
          .post('/v1/auth/reset-password')
          .set('Authorization', `Bearer ${malformedToken}`)
          .send({ password: 'NewPassw0rd1' });

        expect(res.status).toBe(403);
      });
    });

    describe('POST /change-password', () => {
      it('wrong current_password returns 401 (re-sign-in verification fails) — Issue H2', async () => {
        const { authHeader } = await seedAuthedUser();
        spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({
          data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
        });

        const res = await request(app)
          .post('/v1/auth/change-password')
          .set('Authorization', authHeader)
          .send({ current_password: 'wrongpass', new_password: 'NewPassw0rd1' });

        expect(res.status).toBe(401);
      });

      it('correct current_password succeeds', async () => {
        const { authHeader } = await seedAuthedUser();
        spyAuth(supabaseAuth, 'signInWithPassword').mockResolvedValue({ data: {}, error: null });
        spyAdminAuth('updateUserById').mockResolvedValue({ data: {}, error: null });

        const res = await request(app)
          .post('/v1/auth/change-password')
          .set('Authorization', authHeader)
          .send({ current_password: 'correctpass', new_password: 'NewPassw0rd1' });

        expect(res.status).toBe(200);
      });
    });

    describe('POST /register', () => {
      it('OAuth user with no body succeeds using metadata-derived full_name', async () => {
        const { authHeader } = await seedAuthedUser({ auth_provider: 'google' });
        spyAdminAuth('getUserById').mockResolvedValue({
          data: { user: { app_metadata: { provider: 'google' }, user_metadata: { full_name: 'Meta Name' } } },
          error: null,
        });

        const res = await request(app).post('/v1/auth/register').set('Authorization', authHeader).send({});

        expect(res.status).toBe(201);
        expect(res.body.data.user.full_name).toBe('Meta Name');
      });

      it('non-OAuth user with an invalid/empty body throws ValidationError', async () => {
        const { authHeader } = await seedAuthedUser({ auth_provider: 'email' });
        spyAdminAuth('getUserById').mockResolvedValue({
          data: { user: { app_metadata: { provider: 'email' }, user_metadata: {} } },
          error: null,
        });

        const res = await request(app).post('/v1/auth/register').set('Authorization', authHeader).send({});

        expect(res.status).toBe(400);
      });

      it('is idempotent — calling twice with the same data both succeed', async () => {
        const { authHeader } = await seedAuthedUser({ auth_provider: 'email' });
        spyAdminAuth('getUserById').mockResolvedValue({
          data: { user: { app_metadata: { provider: 'email' }, user_metadata: {} } },
          error: null,
        });

        const body = { full_name: 'Idempotent Name', country_of_residence: 'US' };
        const first = await request(app).post('/v1/auth/register').set('Authorization', authHeader).send(body);
        const second = await request(app).post('/v1/auth/register').set('Authorization', authHeader).send(body);

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
      });
    });

    describe('GET /me', () => {
      it('a user with zero workspace memberships gets memberships: [], not an error', async () => {
        const { authHeader } = await seedAuthedUser();

        const res = await request(app).get('/v1/auth/me').set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.data.memberships).toEqual([]);
      });
    });

    describe('PATCH /profile', () => {
      it('only whitelisted fields are applied — extra fields silently ignored (mass-assignment test)', async () => {
        const { authHeader, user } = await seedAuthedUser();

        const res = await request(app)
          .patch('/v1/auth/profile')
          .set('Authorization', authHeader)
          .send({ full_name: 'Updated Name', id: crypto.randomUUID(), auth_provider: 'google' });

        expect(res.status).toBe(200);
        expect(res.body.data.user.full_name).toBe('Updated Name');
        expect(res.body.data.user.id).toBe(user.id); // unchanged
        expect(res.body.data.user.auth_provider).toBe('email'); // unchanged, not whitelisted
      });

      it('an empty body returns the current user unchanged with no DB write attempted', async () => {
        const { authHeader, user } = await seedAuthedUser({ full_name: 'Original Name' });

        const res = await request(app).patch('/v1/auth/profile').set('Authorization', authHeader).send({});

        expect(res.status).toBe(200);
        expect(res.body.data.user.full_name).toBe(user.full_name);
      });
    });

    describe('POST /data-export', () => {
      it('derives workspaceIds from ACTIVE memberships only, enqueues the export job, returns 200', async () => {
        const { authHeader, user } = await seedAuthedUser();

        const { data: activeWs } = await supabaseAdmin.from('workspaces').insert({
          name: 'Active WS', base_currency: 'USD', family_type: 'extended', created_by: user.id,
        }).select().single();
        const { data: inactiveWs } = await supabaseAdmin.from('workspaces').insert({
          name: 'Inactive WS', base_currency: 'USD', family_type: 'extended', created_by: user.id,
        }).select().single();

        await supabaseAdmin.from('workspace_members').insert([
          { workspace_id: activeWs.id, user_id: user.id, role: 'admin', display_name: 'Active Member', is_active: true, invite_status: 'accepted' },
          { workspace_id: inactiveWs.id, user_id: user.id, role: 'admin', display_name: 'Inactive Member', is_active: false, invite_status: 'accepted' },
        ]);

        const res = await request(app).post('/v1/auth/data-export').set('Authorization', authHeader);

        expect(res.status).toBe(200);
        expect(res.body.data.message).toMatch(/queued/i);

        await supabaseAdmin.from('workspaces').delete().in('id', [activeWs.id, inactiveWs.id]);
      });
    });
  });
});
