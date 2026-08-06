// tests/unit/services/group.service.test.js
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
jest.mock('../../../src/services/audit.service');

const groupService = require('../../../src/services/group.service');
const audit = require('../../../src/services/audit.service');
const { NotFoundError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const GROUP_ID = 'group-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'admin-1' };

describe('services/group.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    audit.log.mockResolvedValue();
  });

  describe('createGroup', () => {
    it('one invalid + one valid initial member_id -> invalid silently skipped, valid one added', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID, name: 'Cousins' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'valid-1' }], error: null }); // only valid-1 is real
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // upsert

      await groupService.createGroup({
        workspaceId: WORKSPACE_ID, name: 'Cousins', description: null,
        memberIds: ['valid-1', 'invalid-1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(upsertCall.args[0]).toEqual([{ group_id: GROUP_ID, workspace_member_id: 'valid-1', added_by: 'admin-1' }]);
    });

    it('member-add failure does not fail group creation (logged, not thrown)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID, name: 'Cousins' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'insert failed' } });

      await expect(
        groupService.createGroup({ workspaceId: WORKSPACE_ID, name: 'Cousins', description: null, memberIds: ['m1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).resolves.toEqual({ id: GROUP_ID, name: 'Cousins' });
    });

    it('audit log metadata includes initial_member_count', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID, name: 'Cousins' }, error: null });

      await groupService.createGroup({ workspaceId: WORKSPACE_ID, name: 'Cousins', description: null, memberIds: [], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: { name: 'Cousins', initial_member_count: 0 } }));
    });
  });

  describe('getGroup', () => {
    it('group not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(groupService.getGroup({ workspaceId: WORKSPACE_ID, groupId: 'missing' })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('shapes members with added_at/added_by flattened from group_members', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: {
          id: GROUP_ID, name: 'Cousins', description: null, workspace_id: WORKSPACE_ID, created_by: 'admin-1', created_at: 'x', updated_at: 'x',
          group_members: [{ id: 'gm1', added_at: '2026-01-01', added_by: 'admin-1', workspace_members: { id: 'm1', display_name: 'Bob' } }],
        },
        error: null,
      });

      const result = await groupService.getGroup({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID });

      expect(result.members).toEqual([{ id: 'm1', display_name: 'Bob', added_at: '2026-01-01', added_by: 'admin-1' }]);
    });
  });

  describe('updateGroup', () => {
    it('empty diff -> returns current row without an update call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID, name: 'X' }, error: null });

      const result = await groupService.updateGroup({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID, data: {}, actorCtx: ACTOR_CTX });

      expect(result).toEqual({ id: GROUP_ID, name: 'X' });
      expect(mockSupabaseInstance.getCalls().filter((c) => c.method === 'update').length).toBe(0);
    });

    it('group not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        groupService.updateGroup({ workspaceId: WORKSPACE_ID, groupId: 'missing', data: { name: 'X' }, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('addGroupMembers', () => {
    it('group not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        groupService.addGroupMembers({ workspaceId: WORKSPACE_ID, groupId: 'missing', memberIds: ['m1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('re-adding an already-present member is counted in already_in_group, no duplicate row', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID }, error: null }); // group check
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null }); // valid members
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // upsert returns nothing new (ignoreDuplicates)

      const result = await groupService.addGroupMembers({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID, memberIds: ['m1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(result).toEqual({ added_count: 0, already_in_group: 1 });
    });

    it('already_in_group covers both invalid AND already-present members combined', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'valid-1' }], error: null }); // only valid-1 real
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // upsert: valid-1 already present, 0 new

      const result = await groupService.addGroupMembers({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID, memberIds: ['valid-1', 'invalid-1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(result).toEqual({ added_count: 0, already_in_group: 2 }); // 1 already-present + 1 invalid
    });

    it('audit log only fires when added > 0', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // 0 added

      await groupService.addGroupMembers({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID, memberIds: ['m1'], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('removeGroupMember', () => {
    it('removing a non-member: count 0 -> no audit log call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });

      await groupService.removeGroupMember({ groupId: GROUP_ID, memberId: 'not-in-group', actorCtx: ACTOR_CTX });

      expect(audit.log).not.toHaveBeenCalled();
    });

    it('removing an actual member: count 1 -> audit log called', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 1 });

      await groupService.removeGroupMember({ groupId: GROUP_ID, memberId: 'm1', actorCtx: ACTOR_CTX });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'group.member_removed' }));
    });
  });

  describe('deleteGroup', () => {
    it('group not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        groupService.deleteGroup({ workspaceId: WORKSPACE_ID, groupId: 'missing', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('success: audit logged', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: GROUP_ID }, error: null });

      await groupService.deleteGroup({ workspaceId: WORKSPACE_ID, groupId: GROUP_ID, actorCtx: ACTOR_CTX });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'group.deleted' }));
    });
  });
});
