// tests/audit.service.test.js

// ─────────────────────────────────────────────
// Shared mocks
// ─────────────────────────────────────────────

const mockInsert = jest.fn();
const mockFrom = jest.fn(() => ({ insert: mockInsert }));

jest.mock('../config/supabase', () => ({
  supabaseAdmin: { from: mockFrom },
  supabase: {
    storage: {
      from: jest.fn(),
    },
  },
}));

const mockLoggerError = jest.fn();
jest.mock('../utils/logger', () => ({ error: mockLoggerError }));

// ─────────────────────────────────────────────
// Subjects under test
// ─────────────────────────────────────────────
const { log, fromReq } = require('../src/services/audit.service');

// ─────────────────────────────────────────────
// audit.service
// ─────────────────────────────────────────────
describe('audit.service', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── log() ──────────────────────────────────
  describe('log()', () => {
    it('inserts all fields into audit_log on success', async () => {
      mockInsert.mockResolvedValue({ error: null });

      await log({
        workspaceId: 'ws-1',
        actorUserId: 'u-1',
        actorMemberId: 'm-1',
        action: 'user.login',
        targetType: 'user',
        targetId: 't-1',
        metadata: { key: 'val' },
        ipAddress: '127.0.0.1',
        userAgent: 'Jest/1.0',
      });

      expect(mockFrom).toHaveBeenCalledWith('audit_log');
      expect(mockInsert).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        actor_user_id: 'u-1',
        actor_member_id: 'm-1',
        action: 'user.login',
        target_type: 'user',
        target_id: 't-1',
        metadata: { key: 'val' },
        ip_address: '127.0.0.1',
        user_agent: 'Jest/1.0',
      });
    });

    it('defaults optional fields to null', async () => {
      mockInsert.mockResolvedValue({ error: null });

      await log({ action: 'user.logout' });

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: null,
          actor_user_id: null,
          actor_member_id: null,
          target_type: null,
          target_id: null,
          metadata: null,
          ip_address: null,
          user_agent: null,
        }),
      );
    });

    it('does NOT throw when supabase returns an error — logs instead', async () => {
      mockInsert.mockResolvedValue({ error: { message: 'DB down' } });

      await expect(log({ action: 'some.action' })).resolves.toBeUndefined();

      expect(mockLoggerError).toHaveBeenCalledWith(
        'Audit log write failed',
        expect.objectContaining({ action: 'some.action', error: 'DB down' }),
      );
    });

    it('does NOT throw when the insert rejects — logs instead', async () => {
      mockInsert.mockRejectedValue(new Error('Network timeout'));

      await expect(log({ action: 'some.action' })).resolves.toBeUndefined();

      expect(mockLoggerError).toHaveBeenCalledWith(
        'Audit log write failed',
        expect.objectContaining({ error: 'Network timeout' }),
      );
    });
  });

  // ── fromReq() ──────────────────────────────
  describe('fromReq()', () => {
    it('extracts all fields from a full request object', () => {
      const req = {
        member: { id: 'm-1', workspaceId: 'ws-1' },
        user: { id: 'u-1' },
        ip: '10.0.0.1',
        headers: { 'user-agent': 'TestAgent/2.0' },
      };

      expect(fromReq(req)).toEqual({
        workspaceId: 'ws-1',
        actorUserId: 'u-1',
        actorMemberId: 'm-1',
        ipAddress: '10.0.0.1',
        userAgent: 'TestAgent/2.0',
      });
    });

    it('falls back to null when member and user are absent', () => {
      const req = { ip: '1.2.3.4', headers: {} };

      expect(fromReq(req)).toEqual({
        workspaceId: null,
        actorUserId: null,
        actorMemberId: null,
        ipAddress: '1.2.3.4',
        userAgent: undefined,
      });
    });

    it('falls back to null for workspaceId when member has no workspaceId', () => {
      const req = {
        member: { id: 'm-2' },
        user: { id: 'u-2' },
        ip: '5.6.7.8',
        headers: {},
      };

      const result = fromReq(req);
      expect(result.workspaceId).toBeNull();
      expect(result.actorMemberId).toBe('m-2');
    });
  });
});