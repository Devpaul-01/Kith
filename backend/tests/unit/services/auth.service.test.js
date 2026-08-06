// tests/unit/services/auth.service.test.js
jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase: createMock } = require('../../mocks/supabase.mock');
  const instance = createMock();
  return {
    supabaseAdmin: instance.client,
    supabase: instance.client,
    supabaseAuth: instance.client,
    __mockInstance: instance,
  };
});
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/queues');

const authService = require('../../../src/services/auth.service');
const { getQueue } = require('../../../src/queues');
const {
  ValidationError, UnauthorizedError, ForbiddenError, ConflictError, BusinessRuleError, NotFoundError,
} = require('../../../src/utils/errors');
const { mintTestJWT } = require('../../helpers/authHelper');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const ORIGINAL_ENV = { ...process.env };

describe('services/auth.service', () => {
  let queueAddMock;

  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    process.env.FRONTEND_URL = 'https://app.test.local';
    process.env.SUPABASE_URL = 'https://test.supabase.local';
    process.env.ALLOWED_DEEPLINK_SCHEMES = 'kithapp://';
    queueAddMock = jest.fn().mockResolvedValue({ id: 'job-1' });
    getQueue.mockReturnValue({ add: queueAddMock });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('mapSupabaseAuthError — code-based AND message-substring-based matching', () => {
    it('user_already_exists via code -> ConflictError', () => {
      const err = authService.mapSupabaseAuthError({ code: 'user_already_exists', message: 'x' });
      expect(err).toBeInstanceOf(ConflictError);
    });

    it('user_already_exists via message substring (no code) -> ConflictError', () => {
      const err = authService.mapSupabaseAuthError({ message: 'User already registered' });
      expect(err).toBeInstanceOf(ConflictError);
    });

    it('email_not_confirmed via code -> BusinessRuleError', () => {
      const err = authService.mapSupabaseAuthError({ code: 'email_not_confirmed', message: 'x' });
      expect(err).toBeInstanceOf(BusinessRuleError);
    });

    it('email_not_confirmed via message substring -> BusinessRuleError', () => {
      const err = authService.mapSupabaseAuthError({ message: 'Email not confirmed' });
      expect(err).toBeInstanceOf(BusinessRuleError);
    });

    it('invalid_credentials via code -> UnauthorizedError', () => {
      const err = authService.mapSupabaseAuthError({ code: 'invalid_credentials', message: 'x' });
      expect(err).toBeInstanceOf(UnauthorizedError);
    });

    it('invalid_credentials via message substring -> UnauthorizedError', () => {
      const err = authService.mapSupabaseAuthError({ message: 'Invalid login credentials' });
      expect(err).toBeInstanceOf(UnauthorizedError);
    });

    it('over_email_send_rate_limit -> 429 AppError', () => {
      const err = authService.mapSupabaseAuthError({ code: 'over_email_send_rate_limit', message: 'x' });
      expect(err.statusCode).toBe(429);
    });

    it('weak_password -> ValidationError with field "password"', () => {
      const err = authService.mapSupabaseAuthError({ code: 'weak_password', message: 'Password should be stronger' });
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('password');
    });

    it('unmapped error -> generic 400 AUTH_ERROR', () => {
      const err = authService.mapSupabaseAuthError({ message: 'some unknown thing' });
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('AUTH_ERROR');
    });

    it('handles a completely empty error object without throwing', () => {
      expect(() => authService.mapSupabaseAuthError({})).not.toThrow();
    });
  });

  describe('signup', () => {
    const signupData = { email: 'a@b.com', password: 'Abcdefg1', full_name: 'Bob', country_of_residence: 'US' };

    it('duplicate email -> ConflictError via mapSupabaseAuthError', async () => {
      mockSupabaseInstance.client.auth.signUp.mockResolvedValueOnce({ data: {}, error: { code: 'user_already_exists', message: 'x' } });

      await expect(authService.signup(signupData)).rejects.toBeInstanceOf(ConflictError);
    });

    it('immediate session (email confirmation disabled) -> status "session" with tokens', async () => {
      mockSupabaseInstance.client.auth.signUp.mockResolvedValueOnce({
        data: { user: { id: 'user-1' }, session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const result = await authService.signup(signupData);

      expect(result.status).toBe('session');
      expect(result.body.access_token).toBe('at');
      expect(result.body.profile_setup_required).toBe(false);
    });

    it('no immediate session (confirmation required) -> status "pending_verification"', async () => {
      mockSupabaseInstance.client.auth.signUp.mockResolvedValueOnce({
        data: { user: { id: 'user-1' }, session: null },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const result = await authService.signup(signupData);

      expect(result.status).toBe('pending_verification');
      expect(result.body.email).toBe(signupData.email);
    });

    it('REGRESSION (Issue H3): profile row insert fails -> signup still succeeds, flags profile_setup_required:true', async () => {
      mockSupabaseInstance.client.auth.signUp.mockResolvedValueOnce({
        data: { user: { id: 'user-1' }, session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'db write failed' } });

      const result = await authService.signup(signupData);

      expect(result.status).toBe('session');
      expect(result.body.profile_setup_required).toBe(true);
      expect(result.body.message).toContain('profile setup is incomplete');
    });
  });

  describe('login', () => {
    it('wrong password -> mapped to UnauthorizedError', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({
        data: {}, error: { code: 'invalid_credentials', message: 'x' },
      });

      await expect(
        authService.login({ data: { email: 'a@b.com', password: 'wrong' }, requestId: 'r1', clientIp: '1.2.3.4', userAgent: 'ua' })
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('unconfirmed email -> BusinessRuleError (422)', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({
        data: {}, error: { code: 'email_not_confirmed', message: 'x' },
      });

      await expect(
        authService.login({ data: { email: 'a@b.com', password: 'x' }, requestId: 'r1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('login succeeds but no users row exists -> profile_setup_required:true, user:null', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({
        data: { user: { id: 'user-1' }, session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await authService.login({ data: { email: 'a@b.com', password: 'x' }, requestId: 'r1' });

      expect(result.profile_setup_required).toBe(true);
      expect(result.user).toBeNull();
    });

    it('flattens multiple workspace memberships correctly', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({
        data: { user: { id: 'user-1' }, session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', email: 'a@b.com' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 'm1', role: 'admin', workspace_id: 'ws-1', display_name: 'Bob', workspaces: { name: 'Home', base_currency: 'USD' } },
          { id: 'm2', role: 'member', workspace_id: 'ws-2', display_name: 'Bob', workspaces: { name: 'Work', base_currency: 'EUR' } },
        ],
        error: null,
      });

      const result = await authService.login({ data: { email: 'a@b.com', password: 'x' }, requestId: 'r1' });

      expect(result.memberships).toHaveLength(2);
      expect(result.memberships[0].workspace_name).toBe('Home');
      expect(result.memberships[1].base_currency).toBe('EUR');
    });
  });

  describe('refreshToken', () => {
    it('no refresh_token provided -> UnauthorizedError', async () => {
      await expect(authService.refreshToken({})).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('invalid/expired token -> UnauthorizedError', async () => {
      mockSupabaseInstance.client.auth.refreshSession.mockResolvedValueOnce({ data: {}, error: { message: 'expired' } });

      await expect(authService.refreshToken({ refresh_token: 'stale' })).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('success returns new tokens', async () => {
      mockSupabaseInstance.client.auth.refreshSession.mockResolvedValueOnce({
        data: { session: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 } },
        error: null,
      });

      const result = await authService.refreshToken({ refresh_token: 'valid' });

      expect(result.access_token).toBe('new-at');
    });
  });

  describe('logout / logoutAllDevices — second argument to admin.signOut must differ', () => {
    it('logout calls admin.signOut(userId) WITHOUT the "global" scope', async () => {
      mockSupabaseInstance.client.auth.admin.signOut.mockResolvedValueOnce({ error: null });

      await authService.logout({ userId: 'user-1' });

      expect(mockSupabaseInstance.client.auth.admin.signOut).toHaveBeenCalledWith('user-1');
    });

    it('logoutAllDevices calls admin.signOut(userId, "global")', async () => {
      mockSupabaseInstance.client.auth.admin.signOut.mockResolvedValueOnce({ error: null });

      await authService.logoutAllDevices({ userId: 'user-1' });

      expect(mockSupabaseInstance.client.auth.admin.signOut).toHaveBeenCalledWith('user-1', 'global');
    });
  });

  describe('forgotPassword — always succeeds (anti-enumeration)', () => {
    it('does not throw for any email, real or fake', async () => {
      mockSupabaseInstance.client.auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });

      await expect(authService.forgotPassword({ email: 'nonexistent@example.com' })).resolves.toBeUndefined();
    });
  });

  describe('isRecoverySession / resetPassword', () => {
    it('isRecoverySession: true for a JWT with amr containing recovery', () => {
      const token = mintTestJWT('user-1', { amr: [{ method: 'recovery', timestamp: 123 }] });
      expect(authService.isRecoverySession(`Bearer ${token}`)).toBe(true);
    });

    it('isRecoverySession: false for a non-recovery JWT', () => {
      const token = mintTestJWT('user-1', { amr: [{ method: 'password', timestamp: 123 }] });
      expect(authService.isRecoverySession(`Bearer ${token}`)).toBe(false);
    });

    it('isRecoverySession: false (not throwing) for a malformed/unparseable token', () => {
      expect(authService.isRecoverySession('Bearer not.a.jwt')).toBe(false);
    });

    it('resetPassword: non-recovery session -> ForbiddenError', async () => {
      const token = mintTestJWT('user-1', { amr: [{ method: 'password' }] });

      await expect(
        authService.resetPassword({ authorizationHeader: `Bearer ${token}`, password: 'NewPass1', userId: 'user-1' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('resetPassword: recovery session -> succeeds', async () => {
      const token = mintTestJWT('user-1', { amr: [{ method: 'recovery' }] });
      mockSupabaseInstance.client.auth.admin.updateUserById.mockResolvedValueOnce({ data: {}, error: null });

      await expect(
        authService.resetPassword({ authorizationHeader: `Bearer ${token}`, password: 'NewPass1', userId: 'user-1' })
      ).resolves.toBeUndefined();
    });
  });

  describe('changePassword — verifies current password via real sign-in (Issue H2)', () => {
    it('wrong current_password -> UnauthorizedError (stolen-token protection)', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'invalid' } });

      await expect(
        authService.changePassword({ userEmail: 'a@b.com', userId: 'user-1', current_password: 'wrong', new_password: 'NewPass1' })
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('correct current_password -> succeeds', async () => {
      mockSupabaseInstance.client.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: null });
      mockSupabaseInstance.client.auth.admin.updateUserById.mockResolvedValueOnce({ data: {}, error: null });

      await expect(
        authService.changePassword({ userEmail: 'a@b.com', userId: 'user-1', current_password: 'correct', new_password: 'NewPass1' })
      ).resolves.toBeUndefined();
    });
  });

  describe('isAllowedGoogleRedirect / getGoogleAuthUrl — open-redirect adversarial cases (Issue C2)', () => {
    it('a redirect within FRONTEND_URL origin is allowed', () => {
      expect(authService.isAllowedGoogleRedirect('https://app.test.local/callback')).toBe(true);
    });

    it('an arbitrary external domain is REJECTED', () => {
      expect(authService.isAllowedGoogleRedirect('https://evil.com')).toBe(false);
    });

    it('a configured deep-link scheme is allowed', () => {
      expect(authService.isAllowedGoogleRedirect('kithapp://callback')).toBe(true);
    });

    it('ADVERSARIAL: documents current startsWith behavior for a domain-suffix bypass attempt', () => {
      const bypassAttempt = 'https://app.test.local.evil.com';
      const result = authService.isAllowedGoogleRedirect(bypassAttempt);
      expect(result).toBe(bypassAttempt.startsWith(process.env.FRONTEND_URL));
    });

    it('getGoogleAuthUrl falls back to the default redirect when requestedRedirect is disallowed', async () => {
      const result = await authService.getGoogleAuthUrl({ requestedRedirect: 'https://evil.com', requestIp: '1.2.3.4' });

      expect(result.url).toContain(encodeURIComponent('https://app.test.local/auth/callback'));
    });

    it('getGoogleAuthUrl honors an allowed requestedRedirect', async () => {
      const result = await authService.getGoogleAuthUrl({ requestedRedirect: 'https://app.test.local/custom', requestIp: '1.2.3.4' });

      expect(result.url).toContain(encodeURIComponent('https://app.test.local/custom'));
    });
  });

  describe('googleCallback', () => {
    it('missing code -> ValidationError', async () => {
      await expect(authService.googleCallback({ code: null })).rejects.toBeInstanceOf(ValidationError);
    });

    it('new user (first Google login) upserts with auth_provider google, avatar_url from metadata', async () => {
      mockSupabaseInstance.client.auth.exchangeCodeForSession.mockResolvedValueOnce({
        data: {
          session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
          user: { id: 'user-1', email: 'a@b.com', user_metadata: { full_name: 'Bob', avatar_url: 'https://x/pic.png' } },
        },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const result = await authService.googleCallback({ code: 'valid-code' });

      const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(upsertCall.args[0].avatar_url).toBe('https://x/pic.png');
      expect(upsertCall.args[0].auth_provider).toBe('google');
      expect(result.access_token).toBe('at');
    });

    it('avatar_url falls back to metadata.picture when avatar_url is absent', async () => {
      mockSupabaseInstance.client.auth.exchangeCodeForSession.mockResolvedValueOnce({
        data: {
          session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
          user: { id: 'user-1', email: 'a@b.com', user_metadata: { name: 'Bob', picture: 'https://x/pic2.png' } },
        },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await authService.googleCallback({ code: 'valid-code' });

      const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(upsertCall.args[0].avatar_url).toBe('https://x/pic2.png');
      expect(upsertCall.args[0].full_name).toBe('Bob');
    });

    it('upsert failure does not fail the callback (degraded-but-succeeds pattern)', async () => {
      mockSupabaseInstance.client.auth.exchangeCodeForSession.mockResolvedValueOnce({
        data: { session: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }, user: { id: 'user-1', email: 'a@b.com', user_metadata: {} } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'db down' } });

      await expect(authService.googleCallback({ code: 'valid-code' })).resolves.toHaveProperty('access_token', 'at');
    });
  });

  describe('verifyEmail', () => {
    it('missing token_hash -> ValidationError', async () => {
      await expect(authService.verifyEmail({ token_hash: null })).rejects.toBeInstanceOf(ValidationError);
    });

    it('type defaults to "email" when omitted', async () => {
      mockSupabaseInstance.client.auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: null });

      await authService.verifyEmail({ token_hash: 'tok' });

      expect(mockSupabaseInstance.client.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'tok', type: 'email' });
    });

    it('honors an explicit type', async () => {
      mockSupabaseInstance.client.auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: null });

      await authService.verifyEmail({ token_hash: 'tok', type: 'recovery' });

      expect(mockSupabaseInstance.client.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'tok', type: 'recovery' });
    });

    it('invalid/expired token -> mapped error', async () => {
      mockSupabaseInstance.client.auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', message: 'x' } });

      await expect(authService.verifyEmail({ token_hash: 'bad' })).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  describe('register', () => {
    const parseRegisterSchema = (body) => {
      if (!body.full_name) throw new ValidationError('full_name is required', 'full_name');
      return body;
    };

    it('OAuth user with no body -> succeeds using metadata-derived full_name', async () => {
      mockSupabaseInstance.client.auth.admin.getUserById.mockResolvedValueOnce({
        data: { user: { user_metadata: { full_name: 'Bob' }, app_metadata: { provider: 'google' } } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', full_name: 'Bob' }, error: null });

      const result = await authService.register({ userId: 'user-1', email: 'a@b.com', bodyRaw: {}, parseRegisterSchema });

      expect(result.full_name).toBe('Bob');
    });

    it('non-OAuth user with invalid body -> DOES throw', async () => {
      mockSupabaseInstance.client.auth.admin.getUserById.mockResolvedValueOnce({
        data: { user: { user_metadata: {}, app_metadata: { provider: 'email' } } },
        error: null,
      });

      await expect(
        authService.register({ userId: 'user-1', email: 'a@b.com', bodyRaw: {}, parseRegisterSchema })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('non-OAuth user with no full_name anywhere -> ValidationError', async () => {
      mockSupabaseInstance.client.auth.admin.getUserById.mockResolvedValueOnce({
        data: { user: { user_metadata: {}, app_metadata: { provider: 'email' } } },
        error: null,
      });
      const noThrowParse = () => ({});

      await expect(
        authService.register({ userId: 'user-1', email: 'a@b.com', bodyRaw: {}, parseRegisterSchema: noThrowParse })
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('getMe', () => {
    it('zero memberships -> memberships: [], not an error', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await authService.getMe({ userId: 'user-1', dbUser: { id: 'user-1' } });

      expect(result.memberships).toEqual([]);
    });
  });

  describe('updateProfile — mass-assignment protection', () => {
    it('only whitelisted fields are applied; extra fields silently ignored', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', full_name: 'New Name' }, error: null });

      await authService.updateProfile({ userId: 'user-1', data: { full_name: 'New Name', id: 'attacker-id', auth_provider: 'hacked' } });

      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0]).not.toHaveProperty('id');
      expect(updateCall.args[0]).not.toHaveProperty('auth_provider');
      expect(updateCall.args[0].full_name).toBe('New Name');
    });

    it('empty body -> returns current user, no DB write attempted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1', full_name: 'Unchanged' }, error: null });

      const result = await authService.updateProfile({ userId: 'user-1', data: {} });

      expect(result).toEqual({ id: 'user-1', full_name: 'Unchanged' });
      expect(mockSupabaseInstance.getCalls().filter((c) => c.method === 'update').length).toBe(0);
    });
  });

  describe('deleteContact', () => {
    it('non-existent contactId -> NotFoundError (via .maybeSingle() no-op detection)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(authService.deleteContact({ userId: 'user-1', contactId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('requestDataExport', () => {
    it('derives workspaceIds from active memberships and enqueues the export job', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ workspace_id: 'ws-1' }, { workspace_id: 'ws-2' }], error: null });

      await authService.requestDataExport({ userId: 'user-1', userEmail: 'a@b.com' });

      expect(queueAddMock).toHaveBeenCalledWith(
        'export-user-data',
        expect.objectContaining({ userId: 'user-1', workspaceIds: ['ws-1', 'ws-2'] }),
        expect.objectContaining({ attempts: 2 })
      );
    });
  });
});
