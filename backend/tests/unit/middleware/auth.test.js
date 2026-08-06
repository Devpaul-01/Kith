// tests/unit/middleware/auth.test.js
//
// Uses the project's shared mockSupabase() (tests/mocks/supabase.mock.js)
// for supabaseAdmin, and ioredis-mock (via tests/mocks/redis.mock.js)
// for Redis, per Doc 4's mocking conventions.

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
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../../src/utils/logger');
const { requireAuth, loadDbUser } = require('../../../src/middleware/auth');
const { UnauthorizedError } = require('../../../src/utils/errors');
const { mockReq, mockNext, flushPromises } = require('../../helpers/mockReqRes');
const { __resetRedisMock } = require('../../mocks/redis.mock');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe("middleware/auth", () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    __resetRedisMock();
    jest.clearAllMocks();
  });

  describe('requireAuth', () => {
    it('calls next(UnauthorizedError) when Authorization header is missing', async () => {
      const req = mockReq({ headers: {} });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
      expect(next.mock.calls[0][0].message).toBe('Missing or malformed Authorization header');
    });

    it('calls next(UnauthorizedError) when header is not Bearer-prefixed', async () => {
      const req = mockReq({ headers: { authorization: 'Basic xyz' } });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });

    it('calls next(UnauthorizedError) when supabaseAdmin.auth.getUser returns an error', async () => {
      mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({
        data: { user: null },
        error: { message: 'jwt expired', status: 401 },
      });
      const req = mockReq({ headers: { authorization: 'Bearer sometoken' } });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
      expect(next.mock.calls[0][0].message).toBe('Invalid or expired token');
    });

    it('calls next(UnauthorizedError) when getUser resolves with no error but a null user', async () => {
      mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
      const req = mockReq({ headers: { authorization: 'Bearer sometoken' } });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });

    it('success: sets req.user to exactly { id, email, full_name } and calls next() with no args', async () => {
      mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({
        data: { user: { id: 'user-1', email: 'a@b.com', user_metadata: { full_name: 'Bob' } } },
        error: null,
      });
      // Debounce write path: redis.set(...NX) resolves 'OK' -> triggers update.
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // users.update(...).eq(...) resolution

      const req = mockReq({ headers: { authorization: 'Bearer sometoken' } });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(req.user).toEqual({ id: 'user-1', email: 'a@b.com', full_name: 'Bob' });
      expect(next).toHaveBeenCalledWith();
    });

    it('does not throw when user_metadata is undefined — full_name is simply undefined', async () => {
      mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({
        data: { user: { id: 'user-1', email: 'a@b.com' } }, // no user_metadata
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const req = mockReq({ headers: { authorization: 'Bearer sometoken' } });
      const next = mockNext();

      await requireAuth(req, {}, next);

      expect(req.user.full_name).toBeUndefined();
      expect(next).toHaveBeenCalledWith();
    });

    describe('shouldUpdateLastSeen debounce (fire-and-forget)', () => {
      const validUser = { id: 'user-1', email: 'a@b.com', user_metadata: {} };

      it('performs the users.update write when the Redis NX claim succeeds', async () => {
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });
        mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // the update() resolution

        const req = mockReq({ headers: { authorization: 'Bearer t' } });
        const next = mockNext();

        await requireAuth(req, {}, next);
        // next() fires before the fire-and-forget write resolves.
        expect(next).toHaveBeenCalledWith();

        await flushPromises();
        await flushPromises();

        const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
        expect(updateCalls.length).toBe(1);
      });

      it('does NOT write when the debounce window is already active (redis SET NX returns null)', async () => {
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });

        const req1 = mockReq({ headers: { authorization: 'Bearer t' } });
        await requireAuth(req1, {}, mockNext());
        await flushPromises();

        // Second request within the debounce window for the same user.
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });
        mockSupabaseInstance.reset(); // clear call log but keep Redis state (separate mock)
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });

        const req2 = mockReq({ headers: { authorization: 'Bearer t' } });
        await requireAuth(req2, {}, mockNext());
        await flushPromises();

        const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
        expect(updateCalls.length).toBe(0);
      });

      it('fails open: requireAuth still calls next() successfully when Redis throws, and skips the write', async () => {
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });

        const { getRedis } = require('../../../src/config/redis');
        const realRedis = getRedis();
        const originalSet = realRedis.set.bind(realRedis);
        realRedis.set = jest.fn(() => { throw new Error('Redis is down'); });

        const req = mockReq({ headers: { authorization: 'Bearer t' } });
        const next = mockNext();

        await requireAuth(req, {}, next);
        expect(next).toHaveBeenCalledWith(); // auth itself must not fail

        await flushPromises();

        const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
        expect(updateCalls.length).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith(
          'last_seen_at Redis debounce check failed — skipping write for this request',
          expect.objectContaining({ userId: 'user-1' })
        );

        realRedis.set = originalSet;
      });

      it('the debounce failure never propagates to next(err)', async () => {
        mockSupabaseInstance.client.auth.getUser.mockResolvedValueOnce({ data: { user: validUser }, error: null });

        const { getRedis } = require('../../../src/config/redis');
        const realRedis = getRedis();
        realRedis.set = jest.fn(() => { throw new Error('boom'); });

        const req = mockReq({ headers: { authorization: 'Bearer t' } });
        const next = mockNext();

        await requireAuth(req, {}, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith(); // never called with an error arg
      });
    });
  });

  describe('loadDbUser', () => {
    it('calls next(UnauthorizedError) when req.user is unset (middleware misuse)', async () => {
      const req = mockReq(); // no req.user
      const next = mockNext();

      await loadDbUser(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    });

    it('calls next(plain Error) — not an AppError — when the query itself errors', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'connection reset' } });

      const req = mockReq({ user: { id: 'user-1' } });
      const next = mockNext();

      await loadDbUser(req, {}, next);

      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.constructor.name).toBe('Error'); // plain Error, not a subclass
      expect(err.message).toBe('connection reset');
    });

    it('calls next(UnauthorizedError) when no matching active user row exists', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const req = mockReq({ user: { id: 'user-1' } });
      const next = mockNext();

      await loadDbUser(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
      expect(next.mock.calls[0][0].message).toBe('User profile not found. Please complete registration.');
    });

    it('success: sets req.dbUser to the returned row exactly and calls next() with no args', async () => {
      const row = { id: 'user-1', email: 'a@b.com', full_name: 'Bob', avatar_url: null, timezone: 'UTC', preferred_language: 'en', push_enabled: true, email_digest_enabled: true, deleted_at: null };
      mockSupabaseInstance.mockNextResponse({ data: row, error: null });

      const req = mockReq({ user: { id: 'user-1' } });
      const next = mockNext();

      await loadDbUser(req, {}, next);

      expect(req.dbUser).toEqual(row);
      expect(next).toHaveBeenCalledWith();
    });

    it('requests exactly the expected column list (hot-path perf-sensitive query)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'user-1' }, error: null });

      const req = mockReq({ user: { id: 'user-1' } });
      await loadDbUser(req, {}, mockNext());

      const selectCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'select');
      expect(selectCall.args[0]).toBe(
        'id, email, full_name, avatar_url, timezone, preferred_language, push_enabled, email_digest_enabled, deleted_at'
      );
    });
  });
});
