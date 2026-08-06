// tests/unit/services/cycle_lifecycle.service.test.js
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
jest.mock('../../../src/queues');

const { runCycleLifecycle } = require('../../../src/services/cycle_lifecycle.service');
const notification = require('../../../src/services/notification.service');
const { getQueue } = require('../../../src/queues');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/cycle_lifecycle.service — runCycleLifecycle', () => {
  let queueAddMock;

  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    notification.send.mockResolvedValue();
    queueAddMock = jest.fn().mockResolvedValue({ id: 'job-1' });
    getQueue.mockReturnValue({ add: queueAddMock });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('no due cycles -> opened:0, closed:0', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runCycleLifecycle();

    expect(logger.info).toHaveBeenCalledWith('Cycle lifecycle complete', { opened: 0, closed: 0 });
  });

  describe('openDueCycles — per-participant target fix', () => {
    it('sends EACH participant their OWN target amount, not participant #1\'s shared amount', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'cycle-1', container_id: 'c1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1', name: 'Rent Pool' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1' }] },
          { workspace_member_id: 'm2', contributor_targets: [{ target_amount: 250, target_currency: 'USD', cycle_id: 'cycle-1' }] },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // closeDueCycles

      await runCycleLifecycle();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        recipientIds: ['m1'], variables: expect.objectContaining({ amount: '100 USD' }),
      }));
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        recipientIds: ['m2'], variables: expect.objectContaining({ amount: '250 USD' }),
      }));
    });

    it('participant with no matching target for this cycle gets amount:"TBD"', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'cycle-1', container_id: 'c1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1', name: 'Rent Pool' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ workspace_member_id: 'm1', contributor_targets: [] }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await runCycleLifecycle();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        variables: expect.objectContaining({ amount: 'TBD' }),
      }));
    });

    it('missing container -> skipped, no notification attempted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'cycle-1', container_id: 'missing-container' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await runCycleLifecycle();

      expect(notification.send).not.toHaveBeenCalled();
    });

    it('a notification failure for one participant does not stop the loop for others', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'cycle-1', container_id: 'c1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { workspace_id: 'ws-1', name: 'Rent Pool' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { workspace_member_id: 'm1', contributor_targets: [] },
          { workspace_member_id: 'm2', contributor_targets: [] },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      notification.send.mockRejectedValueOnce(new Error('notif failed')).mockResolvedValueOnce();

      await expect(runCycleLifecycle()).resolves.toBeUndefined();
      expect(notification.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('closeDueCycles — carry-forward logic', () => {
    it('carry_forward_unpaid:true, outstanding balance, next cycle exists -> inserts a carry_forward entry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 40, status: 'confirmed', cycle_id: 'cycle-1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'carry-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await runCycleLifecycle();

      const carryInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.entry_type === 'carry_forward');
      expect(carryInsert.args[0]).toEqual(expect.objectContaining({
        contributor_id: 'm1', original_amount: 60, base_amount: 60, cycle_id: 'next-cycle-1',
        recorded_by: null, confirmed_by: null, status: 'confirmed',
      }));
    });

    it('no next cycle exists -> no carry_forward entry created, no error', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(runCycleLifecycle()).resolves.toBeUndefined();

      const carryInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.entry_type === 'carry_forward');
      expect(carryInsert).toBeUndefined();
    });

    it('carry_forward_unpaid:false -> no carry-forward logic runs regardless of outstanding balance', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: false } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await runCycleLifecycle();

      const carryInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.entry_type === 'carry_forward');
      expect(carryInsert).toBeUndefined();
    });

    it('fully-paid participant gets no carry-forward entry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 100, status: 'confirmed', cycle_id: 'cycle-1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await runCycleLifecycle();

      const carryInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.entry_type === 'carry_forward');
      expect(carryInsert).toBeUndefined();
    });

    it('re-enqueues generate-cycles for each closed cycle', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: false } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await runCycleLifecycle();

      expect(queueAddMock).toHaveBeenCalledWith('generate-cycles', { container_id: 'c1', generate_months_ahead: 3 });
    });
  });
});
