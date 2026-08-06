// tests/unit/middleware/workspace.test.js
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
jest.mock('../../../src/services/membership-cache.service');

const { requireMembership } = require('../../../src/middleware/workspace');
const { NotFoundError } = require('../../../src/utils/errors');
const { mockReq, mockNext, flushPromises } = require('../../helpers/mockReqRes');
const { __resetRedisMock } = require('../../mocks/redis.mock');
const membershipCache = require('../../../src/services/membership-cache.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const VALID_WS_ID = '11111111-1111-4111-8111-111111111111';
const VALID_USER_ID = '22222222-2222-4222-8222-222222222222';

const validMemberRow = {
  id: 'member-1', role: 'member', display_name: 'Bob',
  is_proxy: false, is_active: true, workspace_id: VALID_WS_ID,
};
const validWorkspaceRow = {
  id: VALID_WS_ID, name: 'The Smiths', base_currency: 'USD', visibility: 'private',
};

describe('middleware/workspace — requireMembership', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    __resetRedisMock();
    jest.clearAllMocks();
    membershipCache.getCachedMembership.mockResolvedValue(null);
    membershipCache.setCachedMembership.mockResolvedValue();
  });

  describe('workspaceId param validation', () => {
    it.each(['undefined', 'null', ''])(
      'calls next(NotFoundError) for the literal workspaceId param %p',
      async (badId) => {
        const req = mockReq({ params: { workspaceId: badId }, user: { id: VALID_USER_ID } });
        const next = mockNext();

        await requireMembership(req, {}, next);

        expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
      }
    );

    it('calls next(NotFoundError) — never a validation 400 — for a malformed (non-UUID) workspaceId', async () => {
      const req = mockReq({ params: { workspaceId: 'not-a-uuid' }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.statusCode).toBe(404); // enumeration-resistance: never 403/400 here
    });
  });

  describe('cache-hit path', () => {
    it('sets req.member/req.workspace from the cached payload and makes NO Supabase calls', async () => {
      const cachedPayload = {
        member: { id: 'member-1', role: 'admin', displayName: 'Cached Bob', isProxy: false, isActive: true, workspaceId: VALID_WS_ID },
        workspace: { id: VALID_WS_ID, name: 'Cached WS', baseCurrency: 'USD', visibility: 'private' },
      };
      membershipCache.getCachedMembership.mockResolvedValueOnce(cachedPayload);

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      expect(req.member).toEqual(cachedPayload.member);
      expect(req.workspace).toEqual(cachedPayload.workspace);
      expect(next).toHaveBeenCalledWith();
      expect(mockSupabaseInstance.getCalls().length).toBe(0);
    });
  });

  describe('cache-miss path', () => {
    it('success: fetches member + workspace, maps to camelCase, and caches the result', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      const setCacheSpy = membershipCache.setCachedMembership.mockResolvedValue();

      mockSupabaseInstance.mockNextResponse({ data: validMemberRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: validWorkspaceRow, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      expect(req.member).toEqual({
        id: 'member-1', role: 'member', displayName: 'Bob',
        isProxy: false, isActive: true, workspaceId: VALID_WS_ID,
      });
      expect(req.workspace).toEqual({
        id: VALID_WS_ID, name: 'The Smiths', baseCurrency: 'USD', visibility: 'private',
      });
      expect(next).toHaveBeenCalledWith();
      expect(setCacheSpy).toHaveBeenCalledWith(VALID_WS_ID, VALID_USER_ID, {
        member: req.member,
        workspace: req.workspace,
      });
    });

    it('never selects bank_details in either query (regression: sensitive column must not leak into every request)', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      membershipCache.setCachedMembership.mockResolvedValue();
      mockSupabaseInstance.mockNextResponse({ data: validMemberRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: validWorkspaceRow, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      await requireMembership(req, {}, mockNext());

      const selectCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'select');
      selectCalls.forEach((c) => expect(c.args[0]).not.toMatch(/bank_details/));
    });

    it('member query error -> next(plain Error), not an AppError', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'db exploded' } });
      mockSupabaseInstance.mockNextResponse({ data: validWorkspaceRow, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.constructor.name).toBe('Error');
      expect(err.message).toBe('db exploded');
    });

    it('member query returns no row -> next(NotFoundError)', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: validWorkspaceRow, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });

    it('workspace query error -> next(plain Error)', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      mockSupabaseInstance.mockNextResponse({ data: validMemberRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'workspace query failed' } });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('workspace query failed');
    });

    it('workspace query returns no row -> next(NotFoundError) — distinct code path from member-not-found', async () => {
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      mockSupabaseInstance.mockNextResponse({ data: validMemberRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });

    it('setCachedMembership is called fire-and-forget without blocking the response, even if it resolves slowly', async () => {
      // services/membership-cache.service.js#setCachedMembership wraps
      // its own Redis call in try/catch and never rejects — a Redis
      // failure there resolves normally with a logged warning, not a
      // rejected promise. This test simulates that realistic shape
      // (slow-but-resolving) rather than an unrealistic rejection the
      // real implementation cannot produce, and confirms
      // requireMembership does not await it before calling next().
      membershipCache.getCachedMembership.mockResolvedValueOnce(null);
      let resolveCacheWrite;
      membershipCache.setCachedMembership.mockReturnValueOnce(
        new Promise((resolve) => { resolveCacheWrite = resolve; })
      );
      mockSupabaseInstance.mockNextResponse({ data: validMemberRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: validWorkspaceRow, error: null });

      const req = mockReq({ params: { workspaceId: VALID_WS_ID }, user: { id: VALID_USER_ID } });
      const next = mockNext();

      await requireMembership(req, {}, next);

      // next() already fired even though the cache write promise above
      // is still pending — proves the call is fire-and-forget.
      expect(next).toHaveBeenCalledWith();

      resolveCacheWrite();
      await flushPromises();
    });
  });
});
