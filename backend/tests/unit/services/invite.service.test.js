// tests/unit/services/invite.service.test.js
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
jest.mock('../../../src/services/notification.service');
jest.mock('../../../src/services/audit.service');

const inviteService = require('../../../src/services/invite.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'admin-1' };

const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('services/invite.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
  });

  describe('createInvite', () => {
    it('generates a token, 7-day expiry, and returns invite_url', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'invite-1' }, error: null });

      const result = await inviteService.createInvite({ workspaceId: WORKSPACE_ID, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(result.token).toMatch(/^[0-9a-f]{48}$/); // 24 bytes hex
      expect(result.invite_url).toContain(result.token);
      const expiresAtMs = new Date(result.expires_at).getTime();
      const nowMs = Date.now();
      expect(expiresAtMs - nowMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(expiresAtMs - nowMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    });
  });

  describe('previewInvite — anti-enumeration: not found / expired / used all return the SAME shape', () => {
    it('not found -> { is_valid: false, error }', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      const result = await inviteService.previewInvite({ token: 'unknown' });

      expect(result).toEqual({ is_valid: false, error: 'This invite is invalid or no longer available' });
    });

    it('expired -> { is_valid: false, error }', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { expires_at: pastExpiry, used_at: null }, error: null });

      const result = await inviteService.previewInvite({ token: 'expired-tok' });

      expect(result).toEqual({ is_valid: false, error: 'This invite is invalid or no longer available' });
    });

    it('already used -> { is_valid: false, error }', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { expires_at: futureExpiry, used_at: '2026-01-01' }, error: null });

      const result = await inviteService.previewInvite({ token: 'used-tok' });

      expect(result).toEqual({ is_valid: false, error: 'This invite is invalid or no longer available' });
    });

    it('valid invite -> { is_valid: true } with workspace_name, invited_by_name, container preview', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: {
          expires_at: futureExpiry, used_at: null,
          workspaces: { id: WORKSPACE_ID, name: 'The Smiths' },
          created_by_member: { display_name: 'Admin Bob' },
        },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'c1', name: 'Party', container_type: 'event', enable_money: true, budget_target: 100, budget_currency: 'USD', ledger_entries: [{ base_amount: 50, status: 'confirmed' }] }],
        error: null,
      });

      const result = await inviteService.previewInvite({ token: 'valid-tok' });

      expect(result.is_valid).toBe(true);
      expect(result.workspace_name).toBe('The Smiths');
      expect(result.invited_by_name).toBe('Admin Bob');
      expect(result.active_containers_preview[0].total_confirmed_base).toBe(50);
    });
  });

  describe('acceptInvite — atomic-claim pattern', () => {
    it('invite not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        inviteService.acceptInvite({ token: 'missing', userId: 'user-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('expired invite -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: pastExpiry, used_at: null, workspace_id: WORKSPACE_ID, workspaces: {} }, error: null });

      await expect(
        inviteService.acceptInvite({ token: 'expired', userId: 'user-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('already-used invite -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: futureExpiry, used_at: '2026-01-01', workspace_id: WORKSPACE_ID, workspaces: {} }, error: null });

      await expect(
        inviteService.acceptInvite({ token: 'used', userId: 'user-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('user already a member -> ConflictError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: futureExpiry, used_at: null, workspace_id: WORKSPACE_ID, workspaces: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'existing-member' }, error: null });

      await expect(
        inviteService.acceptInvite({ token: 'valid', userId: 'user-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('REGRESSION (race condition, Issue C4): atomic claim update returns no row -> BusinessRuleError, not a duplicate membership', async () => {
      // Simulates a concurrent accept: the conditional UPDATE
      // (`WHERE used_at IS NULL`) matched zero rows because another
      // request already claimed it between the initial SELECT and this
      // UPDATE — the .maybeSingle() on the claim returns null.
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: futureExpiry, used_at: null, workspace_id: WORKSPACE_ID, workspaces: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // existingMember check: none yet
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // claim UPDATE: 0 rows matched (already claimed)

      await expect(
        inviteService.acceptInvite({ token: 'race-tok', userId: 'user-1', actorCtx: ACTOR_CTX })
      ).rejects.toThrow('This invite has already been used');

      // No workspace_members insert should have happened.
      const memberInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.role === 'member');
      expect(memberInsert).toBeUndefined();
    });

    it('success: creates member, notifies admins, audits', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: futureExpiry, used_at: null, workspace_id: WORKSPACE_ID, workspaces: { id: WORKSPACE_ID, name: 'The Smiths' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // no existing member
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', used_at: '2026-01-01' }, error: null }); // claim succeeds
      mockSupabaseInstance.mockNextResponse({ data: { full_name: 'New Person' }, error: null }); // user lookup
      mockSupabaseInstance.mockNextResponse({ data: { id: 'member-new', display_name: 'New Person' }, error: null }); // member insert
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null }); // admins

      const result = await inviteService.acceptInvite({ token: 'valid', userId: 'user-1', actorCtx: ACTOR_CTX });

      expect(result.member.display_name).toBe('New Person');
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'invite_accepted', recipientIds: ['admin-1'] }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.accepted' }));
    });

    it('falls back to "New Member" display name when user has no full_name', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1', expires_at: futureExpiry, used_at: null, workspace_id: WORKSPACE_ID, workspaces: { id: WORKSPACE_ID, name: 'X' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { full_name: null }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'member-new', display_name: 'New Member' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await inviteService.acceptInvite({ token: 'valid', userId: 'user-1', actorCtx: ACTOR_CTX });

      const memberInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.role === 'member');
      expect(memberInsert.args[0].display_name).toBe('New Member');
    });
  });

  describe('revokeInvite', () => {
    it('non-existent/already-used invite -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        inviteService.revokeInvite({ workspaceId: WORKSPACE_ID, inviteId: 'missing' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('success: deletes the invite', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'inv-1' }, error: null });

      await expect(
        inviteService.revokeInvite({ workspaceId: WORKSPACE_ID, inviteId: 'inv-1' })
      ).resolves.toBeUndefined();
    });
  });

  describe('listInvites', () => {
    const asOf = '2026-11-09T12:00:00.000Z';
    const pagination = { page: 2, perPage: 10, offset: 10 };
    beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(Date.parse(asOf)); });
    afterEach(() => { jest.restoreAllMocks(); });

    it('flattens created_by_name from the joined member', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'inv-1', created_by_member: { display_name: 'Admin Bob' } }], error: null });

      const result = await inviteService.listInvites({ workspaceId: WORKSPACE_ID });

      expect(result[0].created_by_name).toBe('Admin Bob');
      expect(result[0].created_by_member).toBeUndefined();
    });

    it('selects invite metadata, scopes the inviter, and provides exact paging with a service timestamp', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'i1', expires_at: '2026-11-10T00:00:00Z', used_at: null }], error: null, count: 31 });
      const result = await inviteService.listInvites({ workspaceId: WORKSPACE_ID, pagination });
      expect(result).toMatchObject({ invites: [{ id: 'i1', status: 'available' }], count: 31, asOf });
      const calls = mockSupabaseInstance.getCalls();
      const selection = calls.find((call) => call.method === 'select');
      expect(selection.args[0]).not.toMatch(/\*|\btoken\b|used_by_user_id/);
      expect(selection.args[1]).toEqual({ count: 'exact' });
      expect(calls).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['created_by_member.workspace_id', WORKSPACE_ID] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'range', args: [10, 19] },
      ]));
    });

    it('classifies invites using one time snapshot, with used taking precedence over expiry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [
        { id: 'future', expires_at: '2026-11-10T00:00:00Z', used_at: null },
        { id: 'past', expires_at: '2026-11-08T00:00:00Z', used_at: null },
        { id: 'used', expires_at: '2026-11-08T00:00:00Z', used_at: '2026-11-07T00:00:00Z' },
        { id: 'boundary', expires_at: asOf, used_at: null },
      ], count: 4, error: null });
      const result = await inviteService.listInvites({ workspaceId: WORKSPACE_ID, pagination });
      expect(result.invites.map((invite) => invite.status)).toEqual(['available', 'expired', 'used', 'available']);
      expect(result.asOf).toBe(asOf);
    });

    it.each([
      ['available', [{ method: 'is', args: ['used_at', null] }, { method: 'gte', args: ['expires_at', asOf] }]],
      ['expired', [{ method: 'is', args: ['used_at', null] }, { method: 'lt', args: ['expires_at', asOf] }]],
      ['used', [{ method: 'not', args: ['used_at', 'is', null] }]],
    ])('applies %s filters before counting and paging', async (statusFilter, expectedCalls) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count: 0, error: null });
      await inviteService.listInvites({ workspaceId: WORKSPACE_ID, statusFilter, pagination });
      expect(mockSupabaseInstance.getCalls()).toEqual(expect.arrayContaining(expectedCalls));
    });

    it.each([null, undefined, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('fails closed for unavailable or invalid invite counts: %j', async (count) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count, error: null });
      await expect(inviteService.listInvites({ workspaceId: WORKSPACE_ID, pagination })).rejects.toMatchObject({ code: 'INVITES_UNAVAILABLE' });
    });

    it.each([{ data: null, count: 0, error: null }, { data: [], count: 0, error: { message: 'private database details' } },
      { data: [{ expires_at: 'invalid-date' }], count: 1, error: null }])('does not invent an empty list or an invite validity state', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      await expect(inviteService.listInvites({ workspaceId: WORKSPACE_ID, pagination })).rejects.toMatchObject({ code: 'INVITES_UNAVAILABLE' });
    });
  });
});
