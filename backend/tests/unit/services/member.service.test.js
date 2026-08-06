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

    it('filterProxy: "true" (string) matches; anything else evaluates false (current documented behavior)', async () => {
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
      mockSupabaseInstance.mockNextResponse({ data: [{ id: MEMBER_ID }], error: null }); // only 1 active admin

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { role: 'member' }, isAdmin: true, actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('demoting an admin when other admins exist -> succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', updated_at: 'x', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: MEMBER_ID }, { id: 'admin-2' }], error: null }); // 2 admins
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'member' }, error: null }); // update

      await expect(
        memberService.updateMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, data: { role: 'member' }, isAdmin: true, actorMemberId: 'admin-1' })
      ).resolves.toEqual({ id: MEMBER_ID, role: 'member' });
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
      mockSupabaseInstance.mockNextResponse({ data: { id: MEMBER_ID, role: 'admin', users: {} }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: MEMBER_ID }], error: null }); // only 1 admin

      await expect(
        memberService.deleteMember({ workspaceId: WORKSPACE_ID, memberId: MEMBER_ID, callerMemberId: MEMBER_ID, force: 'false', actorCtx: ACTOR_CTX })
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
  });

  describe('getMemberEngagement — delegates to shared engagement.service (Issue M1 de-duplication)', () => {
    it('excludes proxy members from the query and delegates to computeEngagement', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', display_name: 'Bob', last_active_at: null }], error: null });
      engagement.computeEngagement.mockResolvedValueOnce([{ member_id: 'm1', engagement_level: 'active' }]);

      const result = await memberService.getMemberEngagement({ workspaceId: WORKSPACE_ID });

      const proxyEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'is_proxy');
      expect(proxyEqCall.args[1]).toBe(false);
      expect(engagement.computeEngagement).toHaveBeenCalledWith([{ id: 'm1', display_name: 'Bob', last_active_at: null }]);
      expect(result).toEqual([{ member_id: 'm1', engagement_level: 'active' }]);
    });
  });
});
