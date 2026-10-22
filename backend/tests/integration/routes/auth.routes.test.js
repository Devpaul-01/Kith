// tests/integration/routes/auth.routes.test.js
//
// auth.routes.js (mounted /v1/auth) had NO integration test file despite
// being the single most security-sensitive surface in the app — signup,
// login, password reset/change, Google OAuth, session refresh, and the
// account-data endpoints gated behind requireAuth + loadDbUser. Every
// other mounted route file has a dedicated integration-test file; this
// closes that gap.
//
// WHY SUPABASE AUTH METHODS ARE MOCKED HERE (unlike most of this repo's
// integration tests, which hit real Postgres via PostgREST for
// everything): docker-compose.test.yml stands up Postgres + PostgREST
// only, not GoTrue (Supabase's Auth server) — see that file's header
// comment. auth.service.js's signup/login/password flows call
// `getAuthClient().auth.signUp/signInWithPassword/...`, which is a
// network call to a real Supabase Auth instance in production and has
// no local equivalent here. Rather than skip these routes entirely (the
// gap this file exists to close), each test mocks the specific
// `supabaseAdmin.auth.*` method flat on the REAL client the app
// requires — exactly the same technique tests/helpers/authHelper.js
// already uses for `auth.getUser` on every other integration test file
// (mockAuthenticatedRequest/installAuthSpy) — while every other read
// write in these flows (the `users` table row, `workspace_members`
// lookups) still goes through the real test Postgres via PostgREST.
// This exercises the full real HTTP path: validators, authLimiter,
// requireAuth, loadDbUser, the controller's cookie handling, and
// auth.service's own DB reads/writes, with only the literal
// Supabase-Auth network boundary stubbed.
//
// authLimiter is a no-op under NODE_ENV=test (see
// middleware/rateLimiter.js's `skip: (req) => process.env.NODE_ENV ===
// 'test'`, confirmed set by tests/setup.integration.js), so these tests
// do not need to account for rate limiting.

const request = require('supertest');
const crypto  = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest, installAuthSpy } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const { buildUser } = require('../../fixtures/factories');

describe('auth.routes.js — /v1/auth', () => {
  const app = getTestApp();
  const seededWorkspaceIds = [];
  const seededUserIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
    for (const id of seededUserIds) {
      // PostgrestFilterBuilder is thenable but not a real Promise, so
      // .catch() chained directly on it (without first awaiting/then-ing)
      // is not guaranteed to exist as a method — wrap in try/catch
      // instead of relying on Promise-only chaining.
      try {
        await supabaseAdmin.from('users').delete().eq('id', id);
      } catch {
        // best-effort cleanup
      }
    }
  });

  async function seedUser(overrides = {}) {
    const { data: user, error } = await supabaseAdmin
      .from('users').insert(buildUser(overrides)).select().single();
    if (error) throw new Error(`seedUser failed: ${error.message}`);
    seededUserIds.push(user.id);
    return user;
  }

  // ── POST /v1/auth/signup ────────────────────────────────────────
  describe('POST /v1/auth/signup', () => {
    it('invalid payload (weak password) is rejected with 400 VALIDATION_FAILED before any Supabase Auth call', async () => {
      installAuthSpy(supabaseAdmin);
      const signUpSpy = jest.spyOn(supabaseAdmin.auth, 'signUp');

      const res = await request(app)
        .post('/v1/auth/signup')
        .send({ email: 'new@example.test', password: 'weak', full_name: 'Bob', country_of_residence: 'US' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(signUpSpy).not.toHaveBeenCalled();
    });

    it('immediate-session signup (email confirmation disabled) returns 201 with access_token and sets the refresh_token cookie', async () => {
      installAuthSpy(supabaseAdmin);
      const userId = crypto.randomUUID();
      jest.spyOn(supabaseAdmin.auth, 'signUp').mockResolvedValueOnce({
        data: {
          user: { id: userId },
          session: { access_token: 'at-123', refresh_token: 'rt-123', expires_in: 3600 },
        },
        error: null,
      });
      seededUserIds.push(userId); // in case the service inserts a users row as a side effect

      const res = await request(app)
        .post('/v1/auth/signup')
        .send({ email: `signup-${userId}@example.test`, password: 'Abcdefg1', full_name: 'New User', country_of_residence: 'US' });

      expect(res.status).toBe(201);
      expect(res.body.data.access_token).toBe('at-123');
      expect(res.body.data.refresh_token).toBeUndefined(); // stripped before the response body
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some((c) => c.startsWith('refresh_token=rt-123'))).toBe(true);
    });

    it('duplicate email maps to 409 CONFLICT', async () => {
      installAuthSpy(supabaseAdmin);
      jest.spyOn(supabaseAdmin.auth, 'signUp').mockResolvedValueOnce({
        data: {}, error: { code: 'user_already_exists', message: 'User already registered' },
      });

      const res = await request(app)
        .post('/v1/auth/signup')
        .send({ email: 'dup@example.test', password: 'Abcdefg1', full_name: 'Bob', country_of_residence: 'US' });

      expect(res.status).toBe(409);
    });
  });

  // ── POST /v1/auth/login ─────────────────────────────────────────
  describe('POST /v1/auth/login', () => {
    it('valid credentials for an existing user row -> 200 with memberships and refresh_token cookie set', async () => {
      installAuthSpy(supabaseAdmin);
      const { workspace, user, member } = await seedWorkspaceWithAdmin(supabaseAdmin);
      seededWorkspaceIds.push(workspace.id);

      jest.spyOn(supabaseAdmin.auth, 'signInWithPassword').mockResolvedValueOnce({
        data: {
          user: { id: user.id },
          session: { access_token: 'at-login', refresh_token: 'rt-login', expires_in: 3600 },
        },
        error: null,
      });

      const res = await request(app)
        .post('/v1/auth/login')
        .send({ email: user.email, password: 'whatever-the-real-password-is' });

      expect(res.status).toBe(200);
      expect(res.body.data.access_token).toBe('at-login');
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.memberships).toHaveLength(1);
      expect(res.body.data.memberships[0].workspace_id).toBe(workspace.id);
      expect(res.body.data.memberships[0].role).toBe(member.role);
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some((c) => c.startsWith('refresh_token=rt-login'))).toBe(true);
      expect(setCookie.some((c) => c.includes('HttpOnly'))).toBe(true);
    });

    it('wrong password maps to 401 UNAUTHORIZED', async () => {
      installAuthSpy(supabaseAdmin);
      jest.spyOn(supabaseAdmin.auth, 'signInWithPassword').mockResolvedValueOnce({
        data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      });

      const res = await request(app)
        .post('/v1/auth/login')
        .send({ email: 'someone@example.test', password: 'wrong-password' });

      expect(res.status).toBe(401);
    });

    it('valid auth credentials but no matching users row -> 200 with profile_setup_required: true, user: null', async () => {
      installAuthSpy(supabaseAdmin);
      const orphanAuthUserId = crypto.randomUUID();
      jest.spyOn(supabaseAdmin.auth, 'signInWithPassword').mockResolvedValueOnce({
        data: {
          user: { id: orphanAuthUserId },
          session: { access_token: 'at-orphan', refresh_token: 'rt-orphan', expires_in: 3600 },
        },
        error: null,
      });

      const res = await request(app)
        .post('/v1/auth/login')
        .send({ email: 'orphan@example.test', password: 'Abcdefg1' });

      expect(res.status).toBe(200);
      expect(res.body.data.profile_setup_required).toBe(true);
      expect(res.body.data.user).toBeNull();
      expect(res.body.data.memberships).toEqual([]);
    });

    it('malformed body (missing password) is rejected 400 before any Supabase Auth call', async () => {
      installAuthSpy(supabaseAdmin);
      const signInSpy = jest.spyOn(supabaseAdmin.auth, 'signInWithPassword');

      const res = await request(app).post('/v1/auth/login').send({ email: 'a@b.com' });

      expect(res.status).toBe(400);
      expect(signInSpy).not.toHaveBeenCalled();
    });
  });

  // ── POST /v1/auth/refresh ───────────────────────────────────────
  describe('POST /v1/auth/refresh', () => {
    it('valid refresh_token cookie -> 200 with new access_token and a rotated refresh_token cookie', async () => {
      installAuthSpy(supabaseAdmin);
      jest.spyOn(supabaseAdmin.auth, 'refreshSession').mockResolvedValueOnce({
        data: { session: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 } },
        error: null,
      });

      const res = await request(app)
        .post('/v1/auth/refresh')
        .set('Cookie', ['refresh_token=some-old-refresh-token']);

      expect(res.status).toBe(200);
      expect(res.body.data.access_token).toBe('at-new');
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some((c) => c.startsWith('refresh_token=rt-new'))).toBe(true);
    });

    it('no refresh_token cookie present -> 401', async () => {
      const res = await request(app).post('/v1/auth/refresh');
      expect(res.status).toBe(401);
    });

    it('invalid/expired refresh_token -> 401', async () => {
      installAuthSpy(supabaseAdmin);
      jest.spyOn(supabaseAdmin.auth, 'refreshSession').mockResolvedValueOnce({
        data: {}, error: { message: 'Invalid refresh token' },
      });

      const res = await request(app)
        .post('/v1/auth/refresh')
        .set('Cookie', ['refresh_token=expired-token']);

      expect(res.status).toBe(401);
    });
  });

  // ── POST /v1/auth/logout, /logout-all-devices (requireAuth) ──────
  describe('POST /v1/auth/logout + /logout-all-devices', () => {
    it('logout without a bearer token -> 401, never reaches the controller', async () => {
      const res = await request(app).post('/v1/auth/logout');
      expect(res.status).toBe(401);
    });

    it('authenticated logout -> 200, clears the refresh_token cookie', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      jest.spyOn(supabaseAdmin.auth.admin, 'signOut').mockResolvedValueOnce({ error: null });

      const res = await request(app)
        .post('/v1/auth/logout')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const setCookie = res.headers['set-cookie'] || [];
      // clearCookie sends an immediately-expired Set-Cookie for the same name/path
      expect(setCookie.some((c) => c.startsWith('refresh_token=;'))).toBe(true);
    });

    it('logout-all-devices calls signOut with the "global" scope', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      const signOutSpy = jest.spyOn(supabaseAdmin.auth.admin, 'signOut').mockResolvedValueOnce({ error: null });

      const res = await request(app)
        .post('/v1/auth/logout-all-devices')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(signOutSpy).toHaveBeenCalledWith(user.id, 'global');
    });
  });

  // ── POST /v1/auth/forgot-password ───────────────────────────────
  describe('POST /v1/auth/forgot-password', () => {
    it('always returns the same generic 200 message, for both a real and a nonexistent email (anti user-enumeration)', async () => {
      installAuthSpy(supabaseAdmin);
      const resetSpy = jest.spyOn(supabaseAdmin.auth, 'resetPasswordForEmail').mockResolvedValue({ data: {}, error: null });

      const resReal = await request(app).post('/v1/auth/forgot-password').send({ email: 'real-user@example.test' });
      const resFake = await request(app).post('/v1/auth/forgot-password').send({ email: 'definitely-not-registered@example.test' });

      expect(resReal.status).toBe(200);
      expect(resFake.status).toBe(200);
      expect(resReal.body.data.message).toBe(resFake.body.data.message);
      expect(resetSpy).toHaveBeenCalledTimes(2);
    });

    it('malformed email -> 400 before any Supabase Auth call', async () => {
      installAuthSpy(supabaseAdmin);
      const resetSpy = jest.spyOn(supabaseAdmin.auth, 'resetPasswordForEmail');

      const res = await request(app).post('/v1/auth/forgot-password').send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(resetSpy).not.toHaveBeenCalled();
    });
  });

  // ── POST /v1/auth/change-password (requireAuth) ───────────────────
  describe('POST /v1/auth/change-password', () => {
    it('no bearer token -> 401', async () => {
      const res = await request(app)
        .post('/v1/auth/change-password')
        .send({ current_password: 'Abcdefg1', new_password: 'Hijklmn2' });
      expect(res.status).toBe(401);
    });

    it('wrong current_password -> 401 (stolen-access-token protection — the endpoint re-verifies via a real sign-in)', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      jest.spyOn(supabaseAdmin.auth, 'signInWithPassword').mockResolvedValueOnce({
        data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      });

      const res = await request(app)
        .post('/v1/auth/change-password')
        .set('Authorization', authHeader)
        .send({ current_password: 'wrong-password', new_password: 'Hijklmn2' });

      expect(res.status).toBe(401);
    });

    it('correct current_password -> 200', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      jest.spyOn(supabaseAdmin.auth, 'signInWithPassword').mockResolvedValueOnce({ data: {}, error: null });
      jest.spyOn(supabaseAdmin.auth.admin, 'updateUserById').mockResolvedValueOnce({ data: {}, error: null });

      const res = await request(app)
        .post('/v1/auth/change-password')
        .set('Authorization', authHeader)
        .send({ current_password: 'correct-password', new_password: 'Hijklmn2' });

      expect(res.status).toBe(200);
    });

    it('weak new_password is rejected 400 by the validator before any Supabase Auth call', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });
      const signInSpy = jest.spyOn(supabaseAdmin.auth, 'signInWithPassword');

      const res = await request(app)
        .post('/v1/auth/change-password')
        .set('Authorization', authHeader)
        .send({ current_password: 'correct-password', new_password: 'weak' });

      expect(res.status).toBe(400);
      expect(signInSpy).not.toHaveBeenCalled();
    });
  });

  // ── GET /v1/auth/me (requireAuth + loadDbUser) ──────────────────
  describe('GET /v1/auth/me', () => {
    it('no bearer token -> 401', async () => {
      const res = await request(app).get('/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('valid token but no matching users row -> 401 (loadDbUser: "complete registration")', async () => {
      installAuthSpy(supabaseAdmin);
      const unregisteredUserId = crypto.randomUUID();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: unregisteredUserId });

      const res = await request(app).get('/v1/auth/me').set('Authorization', authHeader);

      expect(res.status).toBe(401);
    });

    it('valid token + existing user -> 200 with user and memberships', async () => {
      const { workspace, user } = await seedWorkspaceWithAdmin(supabaseAdmin);
      seededWorkspaceIds.push(workspace.id);
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app).get('/v1/auth/me').set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.memberships).toHaveLength(1);
      expect(res.body.data.memberships[0].workspace_id).toBe(workspace.id);
    });
  });

  // ── PATCH /v1/auth/profile ──────────────────────────────────────
  describe('PATCH /v1/auth/profile', () => {
    it('updates only the whitelisted fields sent and persists them', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .patch('/v1/auth/profile')
        .set('Authorization', authHeader)
        .send({ full_name: 'Updated Name', bio: 'A short bio.' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.full_name).toBe('Updated Name');
      expect(res.body.data.user.bio).toBe('A short bio.');

      const { data: row } = await supabaseAdmin.from('users').select('full_name, bio').eq('id', user.id).single();
      expect(row.full_name).toBe('Updated Name');
    });

    it('invalid avatar_url (not a URL) -> 400', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .patch('/v1/auth/profile')
        .set('Authorization', authHeader)
        .send({ avatar_url: 'not-a-url' });

      expect(res.status).toBe(400);
    });
  });

  // ── Contacts (requireAuth + loadDbUser) ─────────────────────────
  describe('GET/POST/DELETE /v1/auth/contacts', () => {
    it('GET returns an empty array for a user with no contacts yet', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app).get('/v1/auth/contacts').set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.contacts).toEqual([]);
    });

    it('POST creates a contact, then DELETE removes it; a second DELETE 404s', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const createRes = await request(app)
        .post('/v1/auth/contacts')
        .set('Authorization', authHeader)
        .send({ type: 'whatsapp', value: '+1234567890' });

      expect(createRes.status).toBe(201);
      const contactId = createRes.body.data.contact.id;
      expect(contactId).toBeTruthy();

      const listRes = await request(app).get('/v1/auth/contacts').set('Authorization', authHeader);
      expect(listRes.body.data.contacts.some((c) => c.id === contactId)).toBe(true);

      const deleteRes = await request(app)
        .delete(`/v1/auth/contacts/${contactId}`)
        .set('Authorization', authHeader);
      expect(deleteRes.status).toBe(200);

      const secondDeleteRes = await request(app)
        .delete(`/v1/auth/contacts/${contactId}`)
        .set('Authorization', authHeader);
      expect(secondDeleteRes.status).toBe(404);
    });

    it('a user cannot delete another user\'s contact (scoped by user_id -> 404, not 403, per deleteContact\'s no-op-detection design)', async () => {
      const owner = await seedUser();
      const attacker = await seedUser();
      const { authHeader: ownerAuth } = mockAuthenticatedRequest({ supabaseAdmin, userId: owner.id, email: owner.email });
      const { authHeader: attackerAuth } = mockAuthenticatedRequest({ supabaseAdmin, userId: attacker.id, email: attacker.email });

      const createRes = await request(app)
        .post('/v1/auth/contacts')
        .set('Authorization', ownerAuth)
        .send({ type: 'phone', value: '+19998887777' });
      const contactId = createRes.body.data.contact.id;

      const attackerDeleteRes = await request(app)
        .delete(`/v1/auth/contacts/${contactId}`)
        .set('Authorization', attackerAuth);

      expect(attackerDeleteRes.status).toBe(404);

      const stillThereRes = await request(app).get('/v1/auth/contacts').set('Authorization', ownerAuth);
      expect(stillThereRes.body.data.contacts.some((c) => c.id === contactId)).toBe(true);
    });
  });

  // ── POST /v1/auth/push-token, PATCH /v1/auth/notification-preferences ──
  describe('POST /v1/auth/push-token + PATCH /v1/auth/notification-preferences', () => {
    it('registering a push token enables push and persists the token/platform', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .post('/v1/auth/push-token')
        .set('Authorization', authHeader)
        .send({ token: 'a-valid-push-token-value', platform: 'ios' });

      expect(res.status).toBe(200);
      expect(res.body.data.push_enabled).toBe(true);
      expect(res.body.data.platform).toBe('ios');

      const { data: row } = await supabaseAdmin.from('users').select('push_enabled, push_token_platform').eq('id', user.id).single();
      expect(row.push_enabled).toBe(true);
      expect(row.push_token_platform).toBe('ios');
    });

    it('unsupported platform is rejected 400', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .post('/v1/auth/push-token')
        .set('Authorization', authHeader)
        .send({ token: 'a-valid-push-token-value', platform: 'blackberry' });

      expect(res.status).toBe(400);
    });

    it('notification-preferences PATCH persists and echoes the updated flags', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .patch('/v1/auth/notification-preferences')
        .set('Authorization', authHeader)
        .send({ push_enabled: true, email_digest_enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.preferences).toEqual({ push_enabled: true, email_digest_enabled: false });
    });
  });

  // ── POST /v1/auth/data-export (requireAuth + loadDbUser) ──────────
  describe('POST /v1/auth/data-export', () => {
    it('no bearer token -> 401', async () => {
      const res = await request(app).post('/v1/auth/data-export');
      expect(res.status).toBe(401);
    });

    it('authenticated request -> 200 with the queued-export message', async () => {
      const user = await seedUser();
      const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

      const res = await request(app)
        .post('/v1/auth/data-export')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.message).toMatch(/queued/i);
    });
  });
});
