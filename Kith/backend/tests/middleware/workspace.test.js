// tests/middleware/workspace.test.js

jest.mock('../../src/config/supabase', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('../../src/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {
    constructor(message) {
      super(message);
      this.name = 'NotFoundError';
    }
  },
}));

const { supabaseAdmin } = require('../../src/config/supabase');
const { NotFoundError } = require('../../src/utils/errors');
const { requireMembership } = require('../../src/middleware/workspace');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function buildReq(overrides = {}) {
  return {
    params: { workspaceId: VALID_UUID },
    user: { id: 'user-uuid-001' },
    ...overrides,
  };
}

function buildRes() {
  return {}; // middleware never calls res directly
}

/** Build a chainable Supabase query mock that resolves to { data, error }. */
function mockSupabaseChain({ data, error }) {
  const chain = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  };
  return chain;
}

const MEMBER_ROW = {
  id: 'member-001',
  role: 'admin',
  display_name: 'Alice',
  is_proxy: false,
  is_active: true,
  workspace_id: VALID_UUID,
};

const WORKSPACE_ROW = {
  id: VALID_UUID,
  name: 'Acme Corp',
  base_currency: 'USD',
  plan: 'pro',
  visibility: 'private',
  bank_details: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireMembership middleware', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = buildReq();
    res = buildRes();
    next = jest.fn();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    beforeEach(() => {
      supabaseAdmin.from
        .mockReturnValueOnce(mockSupabaseChain({ data: MEMBER_ROW, error: null }))
        .mockReturnValueOnce(mockSupabaseChain({ data: WORKSPACE_ROW, error: null }));
    });

    it('calls next() with no error', async () => {
      await requireMembership(req, res, next);
      expect(next).toHaveBeenCalledWith(/* nothing */);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]).toHaveLength(0);
    });

    it('attaches req.member with camelCase fields', async () => {
      await requireMembership(req, res, next);
      expect(req.member).toEqual({
        id: 'member-001',
        role: 'admin',
        displayName: 'Alice',
        isProxy: false,
        isActive: true,
        workspaceId: VALID_UUID,
      });
    });

    it('attaches req.workspace with camelCase fields', async () => {
      await requireMembership(req, res, next);
      expect(req.workspace).toEqual({
        id: VALID_UUID,
        name: 'Acme Corp',
        baseCurrency: 'USD',
        plan: 'pro',
        visibility: 'private',
        bankDetails: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // workspaceId validation
  // -------------------------------------------------------------------------

  describe('workspaceId validation', () => {
    it.each([
      ['missing (undefined param)', undefined],
      ['string "undefined"', 'undefined'],
      ['string "null"', 'null'],
    ])('throws NotFoundError when workspaceId is %s', async (_label, workspaceId) => {
      req.params.workspaceId = workspaceId;
      await requireMembership(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });

    it.each([
      'not-a-uuid',
      '12345',
      'gggggggg-0000-0000-0000-000000000000',
      '',
    ])('throws NotFoundError for invalid UUID format "%s"', async (workspaceId) => {
      req.params.workspaceId = workspaceId;
      await requireMembership(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });

    it('accepts a valid UUID (both upper and lowercase hex)', async () => {
      req.params.workspaceId = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
      supabaseAdmin.from
        .mockReturnValueOnce(mockSupabaseChain({ data: MEMBER_ROW, error: null }))
        .mockReturnValueOnce(mockSupabaseChain({ data: WORKSPACE_ROW, error: null }));

      await requireMembership(req, res, next);
      expect(next.mock.calls[0]).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Member lookup failures
  // -------------------------------------------------------------------------

  describe('member lookup', () => {
    it('passes a generic Error to next() when Supabase returns a memberErr', async () => {
      supabaseAdmin.from.mockReturnValueOnce(
        mockSupabaseChain({ data: null, error: { message: 'DB connection lost' } })
      );

      await requireMembership(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('DB connection lost');
    });

    it('throws NotFoundError when member row is null (user not in workspace)', async () => {
      supabaseAdmin.from.mockReturnValueOnce(
        mockSupabaseChain({ data: null, error: null })
      );

      await requireMembership(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });
  });

  // -------------------------------------------------------------------------
  // Workspace lookup failures
  // -------------------------------------------------------------------------

  describe('workspace lookup', () => {
    it('passes a generic Error to next() when Supabase returns a wsErr', async () => {
      supabaseAdmin.from
        .mockReturnValueOnce(mockSupabaseChain({ data: MEMBER_ROW, error: null }))
        .mockReturnValueOnce(mockSupabaseChain({ data: null, error: { message: 'Timeout' } }));

      await requireMembership(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Timeout');
    });

    it('throws NotFoundError when workspace row is null (deleted or missing)', async () => {
      supabaseAdmin.from
        .mockReturnValueOnce(mockSupabaseChain({ data: MEMBER_ROW, error: null }))
        .mockReturnValueOnce(mockSupabaseChain({ data: null, error: null }));

      await requireMembership(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    });
  });

  // -------------------------------------------------------------------------
  // Supabase query shape
  // -------------------------------------------------------------------------

  describe('Supabase query construction', () => {
    it('queries workspace_members with correct filters', async () => {
      const memberChain = mockSupabaseChain({ data: MEMBER_ROW, error: null });
      const workspaceChain = mockSupabaseChain({ data: WORKSPACE_ROW, error: null });

      supabaseAdmin.from
        .mockReturnValueOnce(memberChain)
        .mockReturnValueOnce(workspaceChain);

      await requireMembership(req, res, next);

      expect(supabaseAdmin.from).toHaveBeenNthCalledWith(1, 'workspace_members');
      expect(memberChain.eq).toHaveBeenCalledWith('workspace_id', VALID_UUID);
      expect(memberChain.eq).toHaveBeenCalledWith('user_id', req.user.id);
      expect(memberChain.eq).toHaveBeenCalledWith('is_active', true);
      expect(memberChain.is).toHaveBeenCalledWith('deleted_at', null);
    });

    it('queries workspaces with correct filters', async () => {
      const memberChain = mockSupabaseChain({ data: MEMBER_ROW, error: null });
      const workspaceChain = mockSupabaseChain({ data: WORKSPACE_ROW, error: null });

      supabaseAdmin.from
        .mockReturnValueOnce(memberChain)
        .mockReturnValueOnce(workspaceChain);

      await requireMembership(req, res, next);

      expect(supabaseAdmin.from).toHaveBeenNthCalledWith(2, 'workspaces');
      expect(workspaceChain.eq).toHaveBeenCalledWith('id', VALID_UUID);
      expect(workspaceChain.is).toHaveBeenCalledWith('deleted_at', null);
    });

    it('does NOT query workspaces if the member lookup fails', async () => {
      supabaseAdmin.from.mockReturnValueOnce(
        mockSupabaseChain({ data: null, error: null })
      );

      await requireMembership(req, res, next);
      expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
    });
  });
});
