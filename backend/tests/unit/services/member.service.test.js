// tests/unit/services/member.service.test.js
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
jest.mock('../../../src/services/membership-cache.service');
jest.mock('../../../src/services/engagement.service');

const memberService = require('../../../src/services/member.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const membershipCache = require('../../../src/services/membership-cache.service');
const engagement = require('../../../src/services/engagement.service');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const MEMBER_ID = 'member-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'admin-1' };

describe('services/member.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
    membershipCache.invalidateMembership.mockResolvedValue();
    engagement.computeEngagement.mockResolvedValue([]);
  });

  describe('listMembers', () => {
    it('non-admin caller has admin_notes/last_active_at/contribution_streak_months stripped', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: MEMBER_ID, display_name: 'Bob', admin_notes: 'secret', last_active_at: '2026-01-01', contribution_streak_months: 5, users: { email: 'a@b.com' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ role: 'member', is_active: true, is_proxy: false, deleted_at: null }], error: null });

      const result = await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: false, search: null, filterRole: undefined, filterProxy: undefined, sortQuery: {} });

      expect(result.members[0]).not.toHaveProperty('admin_notes');
      expect(result.members[0]).not.toHaveProperty('last_active_at');
      expect(result.members[0]).not.toHaveProperty('contribution_streak_months');
    });

    it('admin caller retains all fields', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: MEMBER_ID, display_name: 'Bob', admin_notes: 'secret', users: {} }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: true, search: null, filterRole: undefined, filterProxy: undefined, sortQuery: {} });

      expect(result.members[0]).toHaveProperty('admin_notes', 'secret');
    });

    it('accepts the existing HTTP string proxy filter', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: true, search: null, filterRole: undefined, filterProxy: 'true', sortQuery: {} });

      const proxyEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'is_proxy');
      expect(proxyEqCall.args[1]).toBe(true);
    });

    it('search term is escaped via containsPattern before the ILIKE query', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: true, search: '50%_x', filterRole: undefined, filterProxy: undefined, sortQuery: {} });

      const ilikeCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'ilike');
      expect(ilikeCall.args[1]).toBe('%50\\%\\_x%');
    });

    it('computes meta counts correctly, excluding soft-deleted rows', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { role: 'admin', is_active: true, is_proxy: false, deleted_at: null },
          { role: 'member', is_active: true, is_proxy: true, deleted_at: null },
          { role: 'admin', is_active: false, is_proxy: false, deleted_at: '2026-01-01' }, // soft-deleted, excluded
        ],
        error: null,
      });

      const result = await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: true, search: null, filterRole: undefined, filterProxy: undefined, sortQuery: {} });

      expect(result.meta).toEqual({ total: 3, admins_count: 1, proxy_count: 1, active_count: 2 });
    });
  });

  describe('getActiveMembership', () => {
    it('checks user ownership, active membership and a non-deleted workspace without using the cache', async () => {
      const row = { id: MEMBER_ID, workspace_id: WORKSPACE_ID, user_id: 'user-1', role: 'member', is_active: true, workspaces: { id: WORKSPACE_ID } };
      mockSupabaseInstance.mockNextResponse({ data: row, error: null });
      const result = await memberService.getActiveMembership({ workspaceId: WORKSPACE_ID, userId: 'user-1' });
      expect(result).toEqual({ id: MEMBER_ID, workspace_id: WORKSPACE_ID, user_id: 'user-1', role: 'member', is_active: true });
      expect(mockSupabaseInstance.builder.select).toHaveBeenCalledWith('id, workspace_id, user_id, role, is_active, workspaces!inner(id)');
      expect(mockSupabaseInstance.builder.eq.mock.calls).toEqual([['workspace_id', WORKSPACE_ID], ['user_id', 'user-1'], ['is_active', true]]);
      expect(mockSupabaseInstance.builder.is.mock.calls).toEqual([['deleted_at', null], ['workspaces.deleted_at', null]]);
    });
    it.each([{ data: null, error: null }, { data: null, error: { message: 'PRIVATE_ERROR' } }])('fails closed on missing or unreadable membership: %j', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      await expect(memberService.getActiveMembership({ workspaceId: WORKSPACE_ID, userId: 'user-1' })).rejects.toMatchObject({ code: response.error ? 'MEMBERS_UNAVAILABLE' : 'NOT_FOUND' });
    });
  });

  describe('member directory reads', () => {
    const pagination = { page: 2, perPage: 10, offset: 10 };

    it('counts the filtered workspace directory without loading profiles or legacy metadata totals', async () => {
      const rows = [{ id: MEMBER_ID, display_name: 'Ada', role: 'member', is_proxy: true, is_active: false }];
      mockSupabaseInstance.mockNextResponse({ data: rows, count: 31, error: null });
      await expect(memberService.listMembers({
        workspaceId: WORKSPACE_ID, isAdmin: false, filterRole: 'member', filterProxy: true, filterActive: false,
        search: '50%_x', sortQuery: { sort: '-joined_at' }, pagination,
      })).resolves.toEqual({ members: rows, count: 31 });
      const calls = mockSupabaseInstance.getCalls();
      expect(calls).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'is', args: ['deleted_at', null] },
        { method: 'eq', args: ['role', 'member'] }, { method: 'eq', args: ['is_proxy', true] },
        { method: 'eq', args: ['is_active', false] }, { method: 'range', args: [10, 19] },
        { method: 'ilike', args: ['display_name', '%50\\%\\_x%'] },
      ]));
      expect(mockSupabaseInstance.builder.order.mock.calls).toEqual([['joined_at', { ascending: false }], ['id', { ascending: true }]]);
      const [columns, options] = mockSupabaseInstance.builder.select.mock.calls[0];
      expect(columns).not.toMatch(/\*|users|user_id|email|date_of_birth|admin_notes|last_active_at|contribution_streak/);
      expect(options).toEqual({ count: 'exact' });
      expect(mockSupabaseInstance.client.from.mock.calls).toEqual([['workspace_members']]);
    });

    it.each([true, false])('applies explicit boolean proxy/active filters: %s', async (value) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count: 0, error: null });
      await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: false, filterProxy: value, filterActive: value, pagination });
      expect(mockSupabaseInstance.getCalls()).toContainEqual({ method: 'eq', args: ['is_proxy', value] });
      expect(mockSupabaseInstance.getCalls()).toContainEqual({ method: 'eq', args: ['is_active', value] });
    });

    it('does not silently exclude inactive members or proxies when filters are omitted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], count: 0, error: null });
      await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: false, pagination });
      const filters = mockSupabaseInstance.getCalls().filter((call) => call.method === 'eq').map((call) => call.args[0]);
      expect(filters).not.toContain('is_active');
      expect(filters).not.toContain('is_proxy');
    });

    it.each([null, undefined, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects an unavailable exact directory count: %j', async (count) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count, error: null });
      await expect(memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: false, pagination }))
        .rejects.toMatchObject({ code: 'MEMBERS_UNAVAILABLE', statusCode: 503 });
    });

    it.each([{ data: null, count: 0, error: null }, { data: [], count: 0, error: { message: 'PRIVATE_DATABASE_FAILURE' } }])('rejects missing rows or database failures', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      const error = await memberService.listMembers({ workspaceId: WORKSPACE_ID, isAdmin: false, pagination }).catch((err) => err);
      expect(error).toMatchObject({ code: 'MEMBERS_UNAVAILABLE', statusCode: 503 });
      expect(error.message).not.toContain('PRIVATE_');
    });

    it('reads a non-deleted member in the workspace without selecting private profile fields', async () => {
      const row = { id: MEMBER_ID, display_name: 'Ada', is_proxy: true, is_active: false };
      mockSupabaseInstance.mockNextResponse({ data: row, error: null });
      await expect(memberService.getMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, isAdmin: false, metadataOnly: true }))
        .resolves.toEqual(row);
      expect(mockSupabaseInstance.getCalls()).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'eq', args: ['id', MEMBER_ID] },
        { method: 'is', args: ['deleted_at', null] },
      ]));
      expect(mockSupabaseInstance.builder.select.mock.calls[0][0]).not.toMatch(/users|email|date_of_birth|admin_notes|last_active_at|contribution_streak/);
      expect(mockSupabaseInstance.client.from).toHaveBeenCalledTimes(1);
    });

    it('keeps missing members distinct from failed lookups', async () => {
      mockSupabaseInstance.mockResponses({ data: null, error: null }, { data: null, error: { message: 'PRIVATE_DATABASE_FAILURE' } });
      const args = { workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, isAdmin: false, metadataOnly: true };
      await expect(memberService.getMember(args)).rejects.toBeInstanceOf(NotFoundError);
      await expect(memberService.getMember(args)).rejects.toMatchObject({ code: 'MEMBERS_UNAVAILABLE', statusCode: 503 });
    });
  });

  describe('createMember', () => {
    it('rejects proxy_managed_by pointing to a non-admin/inactive member', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // adminCheck fails

      await expect(
        memberService.createMember({
          workspaceId: WORKSPACE_ID,
          data: { display_name: 'Grandma', is_proxy: true, proxy_managed_by: 'not-an-admin', role: 'member', relationship_category: 'blood' },
          actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: creates member and writes audit log', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'admin-1' }, error: null }); // adminCheck passes
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, display_name: 'Grandma', is_proxy: true }, error: null });

      const result = await memberService.createMember({
        workspaceId: WORKSPACE_ID,
        data: { display_name: 'Grandma', is_proxy: true, proxy_managed_by: 'admin-1', role: 'member', relationship_category: 'blood' },
        actorCtx: ACTOR_CTX,
      });

      expect(result.id).toBe(MEMBER_ID);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.created' }));
    });
  });

  describe('getMember', () => {
    it('non-admin caller has admin_notes stripped', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, admin_notes: 'secret', users: {} }, error: null });

      const result = await memberService.getMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, isAdmin: false });

      expect(result).not.toHaveProperty('admin_notes');
    });

    it('member not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(memberService.getMember({ workspaceId: WORKSPACE_ID, memberId: 'missing', isAdmin: true })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('updateMember — field-level authorization + last-admin guard + optimistic lock', () => {
    it('non-admin attempting to set an admin-only field -> ForbiddenError naming the field, before any DB call', async () => {
      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { role: 'admin' }, isAdmin: false, actorMemberId: 'caller-1' })
      ).rejects.toThrow("Field 'role' can only be edited by admins");

      expect(mockSupabaseInstance.getCalls().length).toBe(0);
    });

    it('member not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: 'missing', data: { display_name: 'X' }, isAdmin: false, actorMemberId: 'caller-1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('optimistic lock: mismatched version -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, updated_at: '2026-01-01T00:00:00Z', users: {} }, error: null });

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { version: 'stale-version', display_name: 'X' }, isAdmin: false, actorMemberId: 'caller-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('demoting the last admin -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', updated_at: 'x', users: {} }, error: null });
      // assertNotLastActiveAdmin's query excludes the target member
      // (.neq('id', memberId)) and counts OTHER active admins — with no
      // other admin, that query returns an empty list.
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no OTHER active admins

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { role: 'member' }, isAdmin: true, actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('demoting an admin when other admins exist -> succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', updated_at: 'x', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-2' }], error: null }); // 1 other active admin
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member' }, error: null }); // update

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { role: 'member' }, isAdmin: true, actorMemberId: 'admin-1' })
      ).resolves.toEqual({ id: MEMBER_ID, role: 'member' });
    });

    it('deactivating the last active admin -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', is_active: true, updated_at: 'x', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no OTHER active admins

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { is_active: false }, isAdmin: true, actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('deactivating an admin when other active admins exist -> succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', is_active: true, updated_at: 'x', users: { id: 'user-1' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-2' }], error: null }); // 1 other active admin
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, is_active: false }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // member_profile_audit insert

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { is_active: false }, isAdmin: true, actorMemberId: 'admin-1' })
      ).resolves.toEqual({ id: MEMBER_ID, is_active: false });
    });

    it('deactivating a non-admin member -> no last-admin check run, succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', is_active: true, updated_at: 'x', users: { id: 'user-1' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, is_active: false }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // member_profile_audit insert

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { is_active: false }, isAdmin: true, actorMemberId: 'admin-1' })
      ).resolves.toEqual({ id: MEMBER_ID, is_active: false });
    });

    it('proxy_managed_by must reference an active admin', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', updated_at: 'x', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // adminCheck fails

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { proxy_managed_by: 'not-admin' }, isAdmin: true, actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('empty diff -> returns current row, no update call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, updated_at: 'x', users: {} }, error: null });

      const result = await memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: {}, isAdmin: false, actorMemberId: 'caller-1' });

      expect(result.id).toBe(MEMBER_ID);
      const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
      expect(updateCalls.length).toBe(0);
    });

    it('auth-relevant field change -> invalidateMembership called', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', is_active: true, updated_at: 'x', users: { id: 'user-1' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, is_active: false }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // member_profile_audit insert

      await memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { is_active: false }, isAdmin: true, actorMemberId: 'admin-1' });

      expect(membershipCache.invalidateMembership).toHaveBeenCalledWith(WORKSPACE_ID, 'user-1');
    });

    it('non-auth-relevant field change -> invalidateMembership NOT called', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, display_name: 'Old', updated_at: 'x', users: { id: 'user-1' } }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, display_name: 'New' }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // member_profile_audit insert

      await memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { display_name: 'New' }, isAdmin: false, actorMemberId: 'caller-1' });

      expect(membershipCache.invalidateMembership).not.toHaveBeenCalled();
    });

    it('member_profile_audit insert failure does not fail the update (logged, not thrown)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, display_name: 'Old', updated_at: 'x', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, display_name: 'New' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'audit insert failed' } });

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { display_name: 'New' }, isAdmin: false, actorMemberId: 'caller-1' })
      ).resolves.toEqual({ id: MEMBER_ID, display_name: 'New' });
    });
  });

  describe('deleteMember', () => {
    it('last-admin self-removal -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', is_active: true, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no OTHER active admins

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: MEMBER_ID, force: 'false', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('removing a different admin when no other active admin exists -> BusinessRuleError', async () => {
      // Previously only self-removal was guarded; an admin removing a
      // DIFFERENT admin was never checked against the last-admin
      // invariant at all. Covers that the guard now applies regardless
      // of who is acting on whom.
      mockSupabaseInstance.mockNextResponse({ data: { id: 'other-admin', role: 'admin', is_active: true, users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no OTHER active admins besides the target

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: 'other-admin', callerMemberId: MEMBER_ID, force: 'false', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('confirmed entries + force=true -> rejected', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 2 });

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: 'admin-1', force: 'true', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('no confirmed entries + force=true -> hard delete', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // delete

      await memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: 'admin-1', force: 'true', workspaceName: 'X', actorCtx: ACTOR_CTX });

      const deleteCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'delete');
      expect(deleteCall).toBeDefined();
      expect(notification.send).not.toHaveBeenCalled(); // hard-deleted members get no notification
    });

    it('confirmed entries, no force -> soft delete, member_removed notification sent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 5 });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // soft-delete update

      await memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: 'admin-1', force: 'false', workspaceName: 'X', actorCtx: ACTOR_CTX });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'member_removed' }));
    });

    it('notification send failure does not fail the delete (200 even when mock rejects)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // soft-delete update
      notification.send.mockRejectedValueOnce(new Error('notif service down'));

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: 'admin-1', force: 'false', actorCtx: ACTOR_CTX })
      ).resolves.toBeUndefined();
    });

    it('member not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: 'missing', callerMemberId: 'admin-1', force: 'false', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('getContributionSummary', () => {
    it('handles zero ledger entries without error (all-zero shape)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await memberService.getContributionSummary({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID });

      expect(result).toEqual({
        total_containers: 0,
        total_confirmed_count: 0,
        total_paid_base_currency: 0,
        last_contribution_date: null,
        containers: [],
      });
    });

    it('keeps the existing paid-status calculations and non-cycle targets', async () => {
      mockSupabaseInstance.mockResponses(
        { data: [
          { id: 'le-1', container_id: 'c-1', base_amount: '10.25', status: 'confirmed', confirmed_at: '2025-12-01T12:00:00Z' },
          { id: 'le-2', container_id: 'c-1', base_amount: '5.50', status: 'resolved', confirmed_at: '2026-11-02T12:00:00Z' },
          { id: 'le-3', container_id: 'c-2', base_amount: '99', status: 'pending', confirmed_at: null },
          { id: 'le-4', container_id: 'c-1', base_amount: '20', status: 'disputed', confirmed_at: '2026-11-03T12:00:00Z' },
        ], error: null },
        { data: [{
          container_id: 'c-1', containers: { name: 'Rent', workspace_id: WORKSPACE_ID },
          contributor_targets: [
            { is_current: true, cycle_id: 'cycle-1', target_amount: '999', target_currency: 'NGN' },
            { is_current: true, cycle_id: null, target_amount: '30.00', target_currency: 'NGN' },
          ],
        }], error: null },
      );

      await expect(memberService.getContributionSummary({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID })).resolves.toEqual({
        total_containers: 2, total_confirmed_count: 2, total_paid_base_currency: 15.75,
        last_contribution_date: '2026-11-02',
        containers: [{ container_name: 'Rent', paid_base_amount: 15.75, target_amount: '30.00', target_currency: 'NGN', status: 'pending' }],
      });
    });

    it('scopes ledger and participation reads to the requested workspace and member', async () => {
      mockSupabaseInstance.mockResponses({ data: [], error: null }, { data: [], error: null });
      await memberService.getContributionSummary({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID });

      const calls = mockSupabaseInstance.getCalls();
      const participationStart = calls.findIndex((call) => call.method === 'from' && call.args[0] === 'container_participants');
      expect(calls.slice(0, participationStart)).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['contributor_id', MEMBER_ID] },
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
      ]));
      expect(calls.slice(participationStart)).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_member_id', MEMBER_ID] },
        { method: 'eq', args: ['containers.workspace_id', WORKSPACE_ID] },
        { method: 'select', args: [expect.stringContaining('containers!container_participants_container_id_fkey!inner(')] },
      ]));
    });

    it.each(['ledger', 'participations'])('rejects a %s query error instead of returning a partial or zero summary', async (stage) => {
      if (stage === 'participations') mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: { message: 'PRIVATE_DATABASE_DETAIL' } });

      await expect(memberService.getContributionSummary({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID })).rejects.toMatchObject({
        statusCode: 503, code: 'MEMBER_SUMMARY_UNAVAILABLE',
        message: 'Member contribution summary is unavailable. Please try again.',
      });
      expect(mockSupabaseInstance.client.from).toHaveBeenCalledTimes(stage === 'ledger' ? 1 : 2);
    });

    it.each([
      ['ledger', null], ['ledger', {}],
      ['participations', null], ['participations', {}],
    ])('rejects malformed %s data instead of treating it as empty: %j', async (stage, data) => {
      if (stage === 'participations') mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data, error: null });

      await expect(memberService.getContributionSummary({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID }))
        .rejects.toMatchObject({ statusCode: 503, code: 'MEMBER_SUMMARY_UNAVAILABLE' });
    });
  });

  describe('getMemberEngagement — delegates to shared engagement.service (Issue M1 de-duplication)', () => {
    it('excludes proxy members from the query and delegates to computeEngagement', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', display_name: 'Bob', last_active_at: null }], error: null });
      engagement.computeEngagement.mockResolvedValueOnce([{ member_id: 'm1', engagement_level: 'active' }]);

      const result = await memberService.getMemberEngagement({ workspaceId: WORKSPACE_ID });

      const proxyEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'is_proxy');
      expect(proxyEqCall.args[1]).toBe(false);
      expect(engagement.computeEngagement).toHaveBeenCalledWith([{ id: 'm1', display_name: 'Bob', last_active_at: null }], { workspaceId: WORKSPACE_ID });
      expect(result).toEqual([{ member_id: 'm1', engagement_level: 'active' }]);
    });

    it.each([
      { data: [], error: { message: 'PRIVATE_DATABASE_DETAIL' } },
      { data: null, error: null },
      { data: {}, error: null },
    ])('rejects failed or missing member rows before computing engagement: %j', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      await expect(memberService.getMemberEngagement({ workspaceId: WORKSPACE_ID })).rejects.toMatchObject({
        statusCode: 503, code: 'ENGAGEMENT_UNAVAILABLE',
        message: 'Member engagement is unavailable. Please try again.',
      });
      expect(engagement.computeEngagement).not.toHaveBeenCalled();
    });
  });
});
