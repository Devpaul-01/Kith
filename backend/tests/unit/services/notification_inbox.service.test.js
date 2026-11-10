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
  listNotifications, getUnreadCount, getNotification, markAsRead, markAllAsRead,
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
    it('rejects an unavailable count instead of treating it as zero', async () => {
      mockSupabaseInstance.mockNextResponse({ count: null, error: null });
      await expect(getUnreadCount({ memberId: MEMBER_ID })).rejects.toMatchObject({ code: 'NOTIFICATIONS_UNAVAILABLE', statusCode: 503 });
    });

    it('throws on query error', async () => {
      mockSupabaseInstance.mockNextResponse({ count: null, error: { message: 'db error' } });

      await expect(getUnreadCount({ memberId: MEMBER_ID })).rejects.toMatchObject({ code: 'NOTIFICATIONS_UNAVAILABLE', message: 'Notifications are unavailable. Please try again.' });
    });
  });

  describe('notification read boundaries', () => {
    it('scopes both the list and unread count to the same recipient/workspace, regardless of list filter', async () => {
      mockSupabaseInstance.mockResponses({ data: [], count: 31, error: null }, { count: 5, error: null });
      const result = await listNotifications({ memberId: MEMBER_ID, workspaceId: 'ws-1', page: 2, perPage: 10, offset: 10, isRead: true });
      expect(result).toEqual({ notifications: [], count: 31, unread_count: 5 });
      const calls = mockSupabaseInstance.getCalls();
      const starts = calls.map((call, index) => call.method === 'from' ? index : -1).filter((index) => index >= 0);
      for (const segment of [calls.slice(starts[0], starts[1]), calls.slice(starts[1])]) {
        expect(segment).toContainEqual({ method: 'eq', args: ['recipient_id', MEMBER_ID] });
        expect(segment).toContainEqual({ method: 'eq', args: ['workspace_id', 'ws-1'] });
      }
      expect(calls.slice(starts[1])).toContainEqual({ method: 'eq', args: ['is_read', false] });
      expect(mockSupabaseInstance.builder.order.mock.calls).toEqual([['created_at', { ascending: false }], ['id', { ascending: true }]]);
      expect(mockSupabaseInstance.builder.range).toHaveBeenCalledWith(10, 19);
    });

    it('returns a verified zero unread count in the requested workspace', async () => {
      mockSupabaseInstance.mockNextResponse({ count: 0, error: null });
      await expect(getUnreadCount({ memberId: MEMBER_ID, workspaceId: 'ws-1' })).resolves.toBe(0);
      expect(mockSupabaseInstance.builder.eq.mock.calls).toEqual([['recipient_id', MEMBER_ID], ['is_read', false], ['workspace_id', 'ws-1']]);
    });

    it.each([
      [{ data: null, count: 0 }, { count: 0 }], [{ data: [], count: null }, { count: 0 }],
      [{ data: [], count: 0 }, { count: null }], [{ data: [], count: '0' }, { count: 0 }],
      [{ data: [], count: 0 }, { count: -1 }], [{ data: [], count: 0, error: { message: 'PRIVATE' } }, { count: 0 }],
      [{ data: [], count: 0 }, { count: 0, error: { message: 'PRIVATE' } }],
    ])('rejects unavailable list/count data: %j %j', async (page, unread) => {
      mockSupabaseInstance.mockResponses(page, unread);
      await expect(listNotifications({ memberId: MEMBER_ID, page: 1, perPage: 20, offset: 0 }))
        .rejects.toMatchObject({ code: 'NOTIFICATIONS_UNAVAILABLE', statusCode: 503 });
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

  it('loads a preview only from the selected recipient and workspace', async () => {
    mockSupabaseInstance.mockNextResponse({ data: { id: 'n1' }, error: null });
    await getNotification({ notificationId: 'n1', memberId: MEMBER_ID, workspaceId: 'ws-1' });
    expect(mockSupabaseInstance.builder.eq.mock.calls).toEqual([['id', 'n1'], ['recipient_id', MEMBER_ID], ['workspace_id', 'ws-1']]);
    expect(mockSupabaseInstance.builder.select.mock.calls[0][0]).not.toMatch(/body|dedup_key|\*/);
  });

  it('atomically checks all preview fields and unread state before changing a notification', async () => {
    const expectedNotification = { title: 'Task ready', type: 'task.assigned', created_at: '2026-11-09T12:00:00Z', read_at: null };
    mockSupabaseInstance.mockNextResponse({ data: { id: 'n1', is_read: true }, error: null });
    await markAsRead({ notificationId: 'n1', memberId: MEMBER_ID, workspaceId: 'ws-1', expectedNotification });
    expect(mockSupabaseInstance.builder.eq.mock.calls).toEqual([
      ['id', 'n1'], ['recipient_id', MEMBER_ID], ['workspace_id', 'ws-1'], ['is_read', false],
      ['title', 'Task ready'], ['type', 'task.assigned'], ['created_at', expectedNotification.created_at],
    ]);
    expect(mockSupabaseInstance.builder.is).toHaveBeenCalledWith('read_at', null);
  });

  it('returns a conflict when the conditional update matches no row, instead of rewriting read_at', async () => {
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    await expect(markAsRead({ notificationId: 'n1', memberId: MEMBER_ID, workspaceId: 'ws-1', expectedNotification: { title: 'Changed', type: 'task.assigned', created_at: '2026-11-09T12:00:00Z', read_at: null } }))
      .rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    expect(mockSupabaseInstance.builder.update).toHaveBeenCalledTimes(1);
  });
});
