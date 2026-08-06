// tests/unit/services/task_overdue.service.test.js
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
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../src/services/notification.service');

const { runTaskOverdueCheck } = require('../../../src/services/task_overdue.service');
const notification = require('../../../src/services/notification.service');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/task_overdue.service — runTaskOverdueCheck', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    notification.send.mockResolvedValue();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('no overdue tasks -> completes with marked:0', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runTaskOverdueCheck();

    expect(logger.info).toHaveBeenCalledWith('Task overdue check complete', { marked: 0 });
  });

  it('notifies BOTH the assignee and active admins, deduplicated when assignee is also an admin', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'c1', title: 'X', assigned_to: 'admin-1' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });

    await runTaskOverdueCheck();

    const call = notification.send.mock.calls[0][0];
    expect(call.recipientIds).toEqual(['admin-1']);
  });

  it('notifies assignee AND a distinct admin separately when they differ', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'c1', title: 'X', assigned_to: 'member-1' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });

    await runTaskOverdueCheck();

    const call = notification.send.mock.calls[0][0];
    expect(call.recipientIds).toEqual(['member-1', 'admin-1']);
  });

  it('unassigned task: only admins are notified', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'c1', title: 'X', assigned_to: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });

    await runTaskOverdueCheck();

    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ['admin-1'] }));
  });

  it('due_date falls back to "N/A" when absent', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'c1', title: 'X', assigned_to: null, due_date: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runTaskOverdueCheck();

    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ due_date: 'N/A' }),
    }));
  });

  it('deleted/missing container -> task skipped, no notification sent', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'missing', title: 'X', assigned_to: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runTaskOverdueCheck();

    expect(notification.send).not.toHaveBeenCalled();
  });

  it('uses a stable dedupKey format to prevent duplicate daily notifications', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', container_id: 'c1', title: 'X', assigned_to: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runTaskOverdueCheck();

    expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ dedupKey: 'task-overdue:t1:2026-07-21' }));
  });

  it('notification failure for one task does not stop processing of others', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [
        { id: 't1', container_id: 'c1', title: 'X', assigned_to: null },
        { id: 't2', container_id: 'c1', title: 'Y', assigned_to: null },
      ],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    notification.send.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce();

    await expect(runTaskOverdueCheck()).resolves.toBeUndefined();
    expect(notification.send).toHaveBeenCalledTimes(2);
  });
});
