// tests/unit/services/workspace.service.test.js
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
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/services/membership-cache.service');
jest.mock('../../../src/services/dashboard-cache.service');
// Deliberately NOT auto-mocking audit.service — this suite exists partly
// to prove workspace.service.js calls a REAL .log()/.fromReq()-shaped
// function, not one that throws "is not a function" (Doc 1 Finding #4).

const workspaceService = require('../../../src/services/workspace.service');
const audit = require('../../../src/services/audit.service');
const notification = require('../../../src/services/notification.service');
const membershipCache = require('../../../src/services/membership-cache.service');
const dashboardCache = require('../../../src/services/dashboard-cache.service');
const { NotFoundError, ValidationError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'member-1' };

describe('services/workspace.service', () => {
  let auditLogSpy;

  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    membershipCache.invalidateWorkspace.mockResolvedValue();
    dashboardCache.invalidateDashboard.mockResolvedValue();
    // audit.service is intentionally the REAL module (see the "Doc 1
    // Finding #4" describe block below), so its .log() would otherwise
    // attempt a real (mocked-Supabase) insert on every call, consuming
    // a queued response slot other tests don't expect. Spy over the
    // real implementation for every test EXCEPT the dedicated shape/
    // load-time checks, which restore it via afterEach.
    auditLogSpy = jest.spyOn(audit, 'log').mockResolvedValue();
  });

  afterEach(() => {
    auditLogSpy.mockRestore();
  });

  describe('DOC 1 FINDING #4 REGRESSION: audit.log()/fromReq() must be real, callable functions', () => {
    it('audit.service exports the real writer shape ({log, fromReq}), not audit_log.service\'s reader shape ({getAuditLog, exportAuditLogCsv})', () => {
      // This is the direct, load-time proof that workspace.service.js's
      // `const audit = require('./audit.service')` resolves to the
      // fire-and-forget WRITER module — if this ever regresses to
      // importing audit_log.service.js instead (the paginated audit-log
      // READER, which only exports getAuditLog/exportAuditLogCsv and has
      // no .log()/.fromReq() at all), this assertion fails immediately
      // rather than surfacing as a runtime "audit.log is not a function"
      // crash deep inside updateWorkspace/deleteWorkspace/announceToWorkspace.
      expect(typeof audit.log).toBe('function');
      expect(typeof audit.fromReq).toBe('function');
      expect(audit.getAuditLog).toBeUndefined();
      expect(audit.exportAuditLogCsv).toBeUndefined();
    });

    it('updateWorkspace successfully calls audit.log() without throwing "is not a function"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID, name: 'New Name' }, error: null });

      await expect(
        workspaceService.updateWorkspace({ workspaceId: WORKSPACE_ID, data: { name: 'New Name' }, actorCtx: ACTOR_CTX })
      ).resolves.toBeDefined();
    });

    it('deleteWorkspace successfully calls audit.log() without throwing', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID }, error: null });

      await expect(
        workspaceService.deleteWorkspace({ workspaceId: WORKSPACE_ID, actorCtx: ACTOR_CTX })
      ).resolves.toBeUndefined();
    });

    it('announceToWorkspace successfully calls audit.log() without throwing', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'member-1' }], error: null });

      await expect(
        workspaceService.announceToWorkspace({ workspaceId: WORKSPACE_ID, title: 'Hi', body: 'Body', target_role: undefined, actorCtx: ACTOR_CTX })
      ).resolves.toEqual({ sent_count: 1 });
    });

    it('updateSettings successfully calls audit.log() without throwing', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // upsert
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // getSettings re-fetch

      await expect(
        workspaceService.updateSettings({ workspaceId: WORKSPACE_ID, data: { weekly_digest_enabled: true }, actorMemberId: 'member-1', actorCtx: ACTOR_CTX })
      ).resolves.toBeDefined();
    });
  });

  describe('listWorkspacesForUser', () => {
    it('shapes memberships with workspace fields flattened, defaulting missing nested fields to null', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 'm1', role: 'admin', display_name: 'Bob', workspace_id: WORKSPACE_ID, workspaces: { name: 'The Smiths', base_currency: 'USD', avatar_url: null, visibility: 'private' } },
          { id: 'm2', role: 'member', display_name: 'Alice', workspace_id: 'ws-2', workspaces: null },
        ],
        error: null,
      });

      const result = await workspaceService.listWorkspacesForUser({ userId: 'user-1' });

      expect(result[0]).toEqual({
        member_id: 'm1', role: 'admin', display_name: 'Bob', workspace_id: WORKSPACE_ID,
        workspace_name: 'The Smiths', base_currency: 'USD', avatar_url: null, visibility: 'private',
      });
      expect(result[1]).toEqual({
        member_id: 'm2', role: 'member', display_name: 'Alice', workspace_id: 'ws-2',
        workspace_name: null, base_currency: null, avatar_url: null, visibility: null,
      });
    });
  });

  describe('createWorkspace', () => {
    it('calls the create_workspace_with_admin RPC with the expected parameters', async () => {
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'new-ws' }, error: null });

      const result = await workspaceService.createWorkspace({
        userId: 'user-1', name: 'The Smiths', base_currency: 'USD', family_type: 'nuclear', description: 'desc',
      });

      expect(result).toEqual({ id: 'new-ws' });
      const rpcCall = mockSupabaseInstance.getRpcCalls()[0];
      expect(rpcCall.fnName).toBe('create_workspace_with_admin');
      expect(rpcCall.params).toEqual({
        p_name: 'The Smiths', p_base_currency: 'USD', p_family_type: 'nuclear',
        p_description: 'desc', p_user_id: 'user-1',
      });
    });

    it('defaults description to null when omitted', async () => {
      mockSupabaseInstance.mockNextRpcResponse({ data: {}, error: null });

      await workspaceService.createWorkspace({ userId: 'user-1', name: 'X', base_currency: 'USD', family_type: 'other' });

      const rpcCall = mockSupabaseInstance.getRpcCalls()[0];
      expect(rpcCall.params.p_description).toBeNull();
    });

    it('throws a plain Error when the RPC errors', async () => {
      mockSupabaseInstance.mockNextRpcResponse({ data: null, error: { message: 'rpc failed' } });

      await expect(
        workspaceService.createWorkspace({ userId: 'user-1', name: 'X', base_currency: 'USD', family_type: 'other' })
      ).rejects.toThrow('rpc failed');
    });
  });

  describe('getWorkspaceById', () => {
    it('throws NotFoundError when no row is found', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(workspaceService.getWorkspaceById({ workspaceId: WORKSPACE_ID })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('returns the workspace row on success', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID, name: 'X' }, error: null });

      const result = await workspaceService.getWorkspaceById({ workspaceId: WORKSPACE_ID });
      expect(result).toEqual({ id: WORKSPACE_ID, name: 'X' });
    });
  });

  describe('updateWorkspace', () => {
    it('only applies whitelisted fields (mass-assignment protection)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID, name: 'New' }, error: null });

      await workspaceService.updateWorkspace({
        workspaceId: WORKSPACE_ID,
        data: { name: 'New', id: 'attacker-controlled-id', created_by: 'attacker' },
        actorCtx: ACTOR_CTX,
      });

      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0]).not.toHaveProperty('id');
      expect(updateCall.args[0]).not.toHaveProperty('created_by');
      expect(updateCall.args[0].name).toBe('New');
    });

    it('empty diff -> returns current row unchanged, no audit log call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID, name: 'Unchanged' }, error: null });

      const result = await workspaceService.updateWorkspace({ workspaceId: WORKSPACE_ID, data: {}, actorCtx: ACTOR_CTX });

      expect(result).toEqual({ id: WORKSPACE_ID, name: 'Unchanged' });
      expect(auditLogSpy).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the update matches no row (e.g. already deleted)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        workspaceService.updateWorkspace({ workspaceId: WORKSPACE_ID, data: { name: 'X' }, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('deleteWorkspace — cache invalidation (Doc 1 Finding #3)', () => {
    it('calls invalidateWorkspace AND invalidateDashboard on successful delete', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: WORKSPACE_ID }, error: null });

      await workspaceService.deleteWorkspace({ workspaceId: WORKSPACE_ID, actorCtx: ACTOR_CTX });

      expect(membershipCache.invalidateWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(dashboardCache.invalidateDashboard).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('throws NotFoundError when the workspace is already deleted / does not exist', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        workspaceService.deleteWorkspace({ workspaceId: WORKSPACE_ID, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(membershipCache.invalidateWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('getSettings / updateSettings', () => {
    it('getSettings flattens EAV rows into a single settings object', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { setting_key: 'weekly_digest_enabled', setting_value: true },
          { setting_key: 'invite_message', setting_value: { template: 'Welcome!' } },
        ],
        error: null,
      });

      const result = await workspaceService.getSettings({ workspaceId: WORKSPACE_ID });

      expect(result).toEqual({
        weekly_digest_enabled: true,
        invite_message: { template: 'Welcome!' },
      });
    });

    it('updateSettings upserts one row per top-level key, round-tripping a nested object as jsonb', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // upsert
      mockSupabaseInstance.mockNextResponse({ data: [{ setting_key: 'notification_prefs', setting_value: { weekly_digest_enabled: true } }], error: null });

      const result = await workspaceService.updateSettings({
        workspaceId: WORKSPACE_ID,
        data: { notification_prefs: { weekly_digest_enabled: true } },
        actorMemberId: 'member-1',
        actorCtx: ACTOR_CTX,
      });

      const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert');
      expect(upsertCall.args[0]).toEqual([
        expect.objectContaining({
          workspace_id: WORKSPACE_ID,
          setting_key: 'notification_prefs',
          setting_value: { weekly_digest_enabled: true },
        }),
      ]);
      expect(result).toEqual({ notification_prefs: { weekly_digest_enabled: true } });
    });

    it('skips undefined values when building upsert rows', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no upsert call expected since rows.length===0 skips it; this is the getSettings re-fetch

      await workspaceService.updateSettings({
        workspaceId: WORKSPACE_ID,
        data: { weekly_digest_enabled: undefined },
        actorMemberId: 'member-1',
        actorCtx: ACTOR_CTX,
      });

      const upsertCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert');
      expect(upsertCalls.length).toBe(0);
    });
  });

  describe('announceToWorkspace', () => {
    it('target_role omitted -> queries all active members (no role filter)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }, { id: 'm2' }], error: null });

      const result = await workspaceService.announceToWorkspace({
        workspaceId: WORKSPACE_ID, title: 'Hi', body: 'Body', target_role: undefined, actorCtx: ACTOR_CTX,
      });

      expect(result).toEqual({ sent_count: 2 });
      const roleEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'role');
      expect(roleEqCall).toBeUndefined();
    });

    it('target_role: "admin" -> filters to admins only', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });

      await workspaceService.announceToWorkspace({
        workspaceId: WORKSPACE_ID, title: 'Hi', body: 'Body', target_role: 'admin', actorCtx: ACTOR_CTX,
      });

      const roleEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'role');
      expect(roleEqCall.args[1]).toBe('admin');
    });

    it('rejects an invalid target_role with a ValidationError', async () => {
      await expect(
        workspaceService.announceToWorkspace({ workspaceId: WORKSPACE_ID, title: 'Hi', body: 'Body', target_role: 'owner', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('zero matching recipients -> { sent_count: 0 }, notification.send NOT called', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await workspaceService.announceToWorkspace({
        workspaceId: WORKSPACE_ID, title: 'Hi', body: 'Body', target_role: 'admin', actorCtx: ACTOR_CTX,
      });

      expect(result).toEqual({ sent_count: 0 });
      expect(notification.send).not.toHaveBeenCalled();
    });
  });
});
