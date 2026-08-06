// tests/unit/services/notification_inbox.service.test.js
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

const {
  listNotifications, getUnreadCount, markAsRead, markAllAsRead,
} = require('../../../src/services/notification_inbox.service');
const { NotFoundError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const MEMBER_ID = 'member-1';

describe('services/notification_inbox.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  describe('listNotifications', () => {
    it('applies isRead filter with string "true" coercion', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ count: 0, error: null });

      await listNotifications({ memberId: MEMBER_ID, page: 1, perPage: 20, offset: 0, isRead: 'true' });

      const isReadCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'is_read' && c.args[1] === true);
      expect(isReadCall).toBeDefined();
    });

    it('returns unread_count alongside the paginated list', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'n1' }], error: null, count: 1 });
      mockSupabaseInstance.mockNextResponse({ count: 5, error: null });

      const result = await listNotifications({ memberId: MEMBER_ID, page: 1, perPage: 20, offset: 0 });

      expect(result.unread_count).toBe(5);
      expect(result.count).toBe(1);
    });

    it('scopes to workspaceId when provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ count: 0, error: null });

      await listNotifications({ memberId: MEMBER_ID, page: 1, perPage: 20, offset: 0, workspaceId: 'ws-1' });

      const wsCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'workspace_id');
      expect(wsCall.args[1]).toBe('ws-1');
    });
  });

  describe('getUnreadCount', () => {
    it('returns 0 when count is null', async () => {
      mockSupabaseInstance.mockNextResponse({ count: null, error: null });

      const result = await getUnreadCount({ memberId: MEMBER_ID });

      expect(result).toBe(0);
    });

    it('throws on query error', async () => {
      mockSupabaseInstance.mockNextResponse({ count: null, error: { message: 'db error' } });

      await expect(getUnreadCount({ memberId: MEMBER_ID })).rejects.toThrow('db error');
    });
  });

  describe('markAsRead', () => {
    it('marking another member\'s notification -> NotFoundError (scoped by recipient_id)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(markAsRead({ notificationId: 'n1', memberId: MEMBER_ID })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('success sets is_read and read_at', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'n1', is_read: true }, error: null });

      const result = await markAsRead({ notificationId: 'n1', memberId: MEMBER_ID });

      expect(result.is_read).toBe(true);
      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0]).toHaveProperty('read_at');
    });
  });

  describe('markAllAsRead', () => {
    it('without workspace_id scoping: marks all unread across every workspace', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'n1' }, { id: 'n2' }], error: null });

      const result = await markAllAsRead({ memberId: MEMBER_ID });

      expect(result).toBe(2);
      const wsCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'workspace_id');
      expect(wsCall).toBeUndefined();
    });

    it('with workspace_id: scopes the update to that workspace only', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'n1' }], error: null });

      await markAllAsRead({ memberId: MEMBER_ID, workspaceId: 'ws-1' });

      const wsCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'workspace_id');
      expect(wsCall.args[1]).toBe('ws-1');
    });

    it('returns 0 when nothing was unread', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await markAllAsRead({ memberId: MEMBER_ID });

      expect(result).toBe(0);
    });
  });
});
