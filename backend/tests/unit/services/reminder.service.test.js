// tests/unit/services/reminder.service.test.js
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

const { runReminderScan } = require('../../../src/services/reminder.service');
const notification = require('../../../src/services/notification.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/reminder.service — runReminderScan', () => {
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

  it('a fully empty scan completes without error', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await expect(runReminderScan()).resolves.toBeUndefined();
    expect(notification.send).not.toHaveBeenCalled();
  });

  describe('sendUpcomingPaymentReminders', () => {
    it('sends a payment_reminder for an active-container target with the expected dedupKey', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 't1', target_amount: 50, target_currency: 'USD', due_date: '2026-07-25', workspace_member_id: 'm1', container: { id: 'c1', name: 'Rent', workspace_id: 'ws-1', status: 'active' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await runReminderScan();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'payment_reminder', recipientIds: ['m1'], dedupKey: 'payment_reminder:t1:2026-07-21',
      }));
    });

    it('skips a target whose container is not active', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 't1', target_amount: 50, target_currency: 'USD', due_date: '2026-07-25', workspace_member_id: 'm1', container: { id: 'c1', name: 'Rent', workspace_id: 'ws-1', status: 'archived' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await runReminderScan();

      expect(notification.send).not.toHaveBeenCalled();
    });

    it('a target with no container (deleted) is skipped safely', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 't1', target_amount: 50, target_currency: 'USD', due_date: '2026-07-25', workspace_member_id: 'm1', container: null }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await expect(runReminderScan()).resolves.toBeUndefined();
      expect(notification.send).not.toHaveBeenCalled();
    });

    it('a notification failure for one target does not stop the scan (per-item isolation)', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 't1', target_amount: 50, target_currency: 'USD', due_date: '2026-07-25', workspace_member_id: 'm1', container: { id: 'c1', name: 'X', workspace_id: 'ws-1', status: 'active' } },
          { id: 't2', target_amount: 20, target_currency: 'USD', due_date: '2026-07-26', workspace_member_id: 'm2', container: { id: 'c1', name: 'X', workspace_id: 'ws-1', status: 'active' } },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      notification.send.mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce();

      await expect(runReminderScan()).resolves.toBeUndefined();
      expect(notification.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendOverdueReminders + sendAdminOverdueSummaries', () => {
    it('sends overdue_reminder to each member AND groups into ONE admin summary per container', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 't1', target_amount: 50, target_currency: 'USD', due_date: '2026-07-01', workspace_member_id: 'm1', container: { id: 'c1', name: 'Rent', workspace_id: 'ws-1', status: 'active' } },
          { id: 't2', target_amount: 30, target_currency: 'USD', due_date: '2026-07-02', workspace_member_id: 'm2', container: { id: 'c1', name: 'Rent', workspace_id: 'ws-1', status: 'active' } },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await runReminderScan();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'overdue_reminder', recipientIds: ['m1'] }));
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'overdue_reminder', recipientIds: ['m2'] }));
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'overdue_summary_admin', variables: expect.objectContaining({ count: 2 }) }));
    });
  });

  describe('sendCycleClosingSoonReminders', () => {
    it('computes outstanding correctly (target - confirmed paid)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cy1', cycle_end: '2026-07-24', container_id: 'c1', containers: { id: 'c1', name: 'Pool', workspace_id: 'ws-1', status: 'active' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cy1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 40 }], error: null });

      await runReminderScan();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'cycle_closing_soon', variables: expect.objectContaining({ outstanding: '60.00 USD' }),
      }));
    });

    it('participant with outstanding <= 0 is not notified', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cy1', cycle_end: '2026-07-24', container_id: 'c1', containers: { id: 'c1', name: 'Pool', workspace_id: 'ws-1', status: 'active' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cy1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 100 }], error: null });

      await runReminderScan();

      expect(notification.send).not.toHaveBeenCalled();
    });

    it('a non-active container is skipped entirely', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cy1', cycle_end: '2026-07-24', container_id: 'c1', containers: { id: 'c1', name: 'Pool', workspace_id: 'ws-1', status: 'archived' } }],
        error: null,
      });

      await runReminderScan();

      expect(notification.send).not.toHaveBeenCalled();
    });
  });
});
