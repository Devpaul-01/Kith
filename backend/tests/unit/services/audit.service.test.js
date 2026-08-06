// tests/unit/services/audit.service.test.js
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
jest.mock('../../../src/services/dashboard-cache.service');

const audit = require('../../../src/services/audit.service');
const logger = require('../../../src/utils/logger');
const dashboardCache = require('../../../src/services/dashboard-cache.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/audit.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    dashboardCache.invalidateDashboard.mockResolvedValue();
  });

  describe('log — fire-and-forget, never throws', () => {
    it('writes the audit_log row with all provided fields', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await audit.log({
        workspaceId: 'ws-1', actorUserId: 'user-1', actorMemberId: 'member-1',
        action: 'container.created', targetType: 'container', targetId: 'c1',
        metadata: { name: 'Party' }, ipAddress: '1.2.3.4', userAgent: 'ua',
      });

      const insertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert');
      expect(insertCall.args[0]).toEqual({
        workspace_id: 'ws-1', actor_user_id: 'user-1', actor_member_id: 'member-1',
        action: 'container.created', target_type: 'container', target_id: 'c1',
        metadata: { name: 'Party' }, ip_address: '1.2.3.4', user_agent: 'ua',
      });
    });

    it('defaults optional fields to null when omitted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await audit.log({ action: 'workspace.deleted' });

      const insertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert');
      expect(insertCall.args[0].workspace_id).toBeNull();
      expect(insertCall.args[0].metadata).toBeNull();
    });

    it('a DB insert error is caught and logged, never thrown', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'insert failed' } });

      await expect(audit.log({ action: 'x' })).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith('Audit log write failed', expect.objectContaining({ action: 'x' }));
    });

    it('invalidates the dashboard cache when workspaceId is provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await audit.log({ workspaceId: 'ws-1', action: 'x' });

      expect(dashboardCache.invalidateDashboard).toHaveBeenCalledWith('ws-1');
    });

    it('does NOT invalidate the dashboard cache when workspaceId is absent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await audit.log({ action: 'x' });

      expect(dashboardCache.invalidateDashboard).not.toHaveBeenCalled();
    });

    it('still invalidates the dashboard even when the insert itself failed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'db down' } });

      await audit.log({ workspaceId: 'ws-1', action: 'x' });

      expect(dashboardCache.invalidateDashboard).toHaveBeenCalledWith('ws-1');
    });
  });

  describe('fromReq', () => {
    it('extracts fields from a fully-populated Express req', () => {
      const req = {
        member: { workspaceId: 'ws-1', id: 'member-1' },
        user: { id: 'user-1' },
        ip: '1.2.3.4',
        headers: { 'user-agent': 'test-agent' },
      };

      expect(audit.fromReq(req)).toEqual({
        workspaceId: 'ws-1', actorUserId: 'user-1', actorMemberId: 'member-1',
        ipAddress: '1.2.3.4', userAgent: 'test-agent',
      });
    });

    it('defaults to null for a pre-auth/pre-membership req without throwing', () => {
      const req = { headers: {}, ip: '1.2.3.4' };

      expect(() => audit.fromReq(req)).not.toThrow();
      const result = audit.fromReq(req);
      expect(result.workspaceId).toBeNull();
      expect(result.actorUserId).toBeNull();
      expect(result.actorMemberId).toBeNull();
    });
  });
});
