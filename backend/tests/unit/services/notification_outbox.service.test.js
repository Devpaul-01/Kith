// tests/unit/services/notification_outbox.service.test.js
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
jest.mock('../../../src/queues');

const { runNotificationOutboxScan } = require('../../../src/services/notification_outbox.service');
const { getQueue } = require('../../../src/queues');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/notification_outbox.service — runNotificationOutboxScan', () => {
  let queueAddMock;

  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    queueAddMock = jest.fn().mockResolvedValue({ id: 'job-1' });
    getQueue.mockReturnValue({ add: queueAddMock });
  });

  it('no stale deliveries -> returns early, no queue interaction', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runNotificationOutboxScan();

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('re-enqueues a stale delivery with the ARRAY-WRAPPED users shape', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [{
        id: 'delivery-1', channel: 'push', notification_id: 'notif-1',
        notifications: {
          id: 'notif-1', title: 'Hi', body: 'Body', workspace_id: 'ws-1', reference_type: 'task', reference_id: 't1',
          workspace_members: { is_proxy: false, users: [{ id: 'user-1', push_token: 'tok', push_enabled: true }] },
        },
      }],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runNotificationOutboxScan();

    expect(queueAddMock).toHaveBeenCalledWith('deliver-push', expect.objectContaining({ recipient_user_id: 'user-1', push_token: 'tok' }), expect.any(Object));
  });

  it('re-enqueues a stale delivery with the BARE-OBJECT users shape', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [{
        id: 'delivery-1', channel: 'email', notification_id: 'notif-1',
        notifications: {
          id: 'notif-1', title: 'Hi', body: 'Body', workspace_id: 'ws-1', reference_type: 'task', reference_id: 't1',
          workspace_members: { is_proxy: false, users: { id: 'user-1', email: 'a@b.com', email_digest_enabled: true } },
        },
      }],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runNotificationOutboxScan();

    expect(queueAddMock).toHaveBeenCalledWith('deliver-email', expect.objectContaining({ email: 'a@b.com' }), expect.any(Object));
  });

  it('proxy-member recipient is NOT re-enqueued', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [{
        id: 'delivery-1', channel: 'push', notification_id: 'notif-1',
        notifications: {
          id: 'notif-1', title: 'Hi', body: 'Body', workspace_id: 'ws-1',
          workspace_members: { is_proxy: true, users: null },
        },
      }],
      error: null,
    });

    await runNotificationOutboxScan();

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('resets delivery status to "pending" after successful re-enqueue', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [{
        id: 'delivery-1', channel: 'push', notification_id: 'notif-1',
        notifications: { id: 'notif-1', title: 'Hi', body: 'Body', workspace_members: { is_proxy: false, users: { id: 'user-1' } } },
      }],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runNotificationOutboxScan();

    const resetUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'pending');
    expect(resetUpdate).toBeDefined();
  });

  it('a delivery with no notification record (deleted) is skipped safely', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'delivery-1', channel: 'push', notification_id: 'gone', notifications: null }], error: null });

    await expect(runNotificationOutboxScan()).resolves.toBeUndefined();
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('re-enqueue failure for one delivery does not stop others', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [
        { id: 'd1', channel: 'push', notification_id: 'n1', notifications: { id: 'n1', title: 'A', body: 'B', workspace_members: { is_proxy: false, users: { id: 'u1' } } } },
        { id: 'd2', channel: 'push', notification_id: 'n2', notifications: { id: 'n2', title: 'C', body: 'D', workspace_members: { is_proxy: false, users: { id: 'u2' } } } },
      ],
      error: null,
    });
    queueAddMock.mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce({ id: 'job-2' });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await expect(runNotificationOutboxScan()).resolves.toBeUndefined();
    expect(queueAddMock).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('Failed to re-enqueue stale delivery', expect.objectContaining({ deliveryId: 'd1' }));
  });
});
