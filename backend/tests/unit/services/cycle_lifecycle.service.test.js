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

  describe('closeDueCycles — carry-forward-as-debt logic', () => {
    it('carry_forward_unpaid:true, outstanding balance, next cycle exists -> calls apply_cycle_carry_forward_atomic and notifies the participant', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // openDueCycles: toOpen
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      }); // closeDueCycles: toClose
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null }); // claim (conditional update)
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      }); // carryForwardUnpaid: participants
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 40, status: 'confirmed', cycle_id: 'cycle-1' }], error: null }); // ledger
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1', cycle_end: '2026-08-31' }, error: null }); // nextCycle
      mockSupabaseInstance.mockNextRpcResponse({ data: { applied: true, carried_amount: 60, new_target: { id: 't2', target_amount: 160 } }, error: null }); // apply_cycle_carry_forward_atomic

      await runCycleLifecycle();

      const rpcCall = mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'apply_cycle_carry_forward_atomic');
      expect(rpcCall.params).toEqual({
        p_container_participant_id: 'p1', p_container_id: 'c1', p_workspace_member_id: 'm1',
        p_from_cycle_id: 'cycle-1', p_to_cycle_id: 'next-cycle-1',
        p_amount: 60, p_currency: 'USD', p_due_date: '2026-08-31', p_set_by: 'admin-1',
      });

      // No ledger_entries insert of any kind — carry-forward is a target bump, not a payment.
      const ledgerInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'insert' && c.args[0]?.entry_type === 'carry_forward');
      expect(ledgerInsert).toBeUndefined();

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'carry_forward_applied', recipientIds: ['m1'],
        variables: expect.objectContaining({ amount: '60.00 USD' }),
      }));
    });

    it('REGRESSION: a resolved (disputed-then-resolved) entry counts as paid — no double-charge carry-forward', async () => {
      // A contribution that was confirmed, disputed, and resolved in the
      // contributor's favor is still money they paid. Filtering only on
      // status === 'confirmed' here used to make this function treat
      // that amount as still outstanding and tack it on again as a NEW
      // debt on the next cycle's target — an actual double-charge.
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // openDueCycles: toOpen
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      }); // closeDueCycles: toClose
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null }); // claim (conditional update)
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      }); // carryForwardUnpaid: participants
      // Fully paid via a resolved dispute, not a plain confirmed entry.
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 100, status: 'resolved', cycle_id: 'cycle-1' }], error: null }); // ledger
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1', cycle_end: '2026-08-31' }, error: null }); // nextCycle

      await runCycleLifecycle();

      // outstanding = 100 (target) - 100 (resolved, paid) = 0 -> no RPC call at all
      const rpcCall = mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'apply_cycle_carry_forward_atomic');
      expect(rpcCall).toBeUndefined();
      expect(notification.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'carry_forward_applied' }));
    });

    it('RPC reports already applied (prior run) -> no notification sent', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 40, status: 'confirmed', cycle_id: 'cycle-1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1', cycle_end: '2026-08-31' }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { applied: false, reason: 'already_applied' }, error: null });

      await runCycleLifecycle();

      expect(notification.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'carry_forward_applied' }));
    });

    it('no next cycle exists -> RPC never called, no error', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // ledger
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // nextCycle: none found

      await expect(runCycleLifecycle()).resolves.toBeUndefined();

      expect(mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'apply_cycle_carry_forward_atomic')).toBeUndefined();
    });

    it('carry_forward_unpaid:false -> no carry-forward logic runs regardless of outstanding balance', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: false, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

      await runCycleLifecycle();

      expect(mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'apply_cycle_carry_forward_atomic')).toBeUndefined();
    });

    it('fully-paid participant -> RPC never called', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', base_amount: 100, status: 'confirmed', cycle_id: 'cycle-1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1', cycle_end: '2026-08-31' }, error: null });

      await runCycleLifecycle();

      expect(mockSupabaseInstance.getRpcCalls().find((c) => c.fnName === 'apply_cycle_carry_forward_atomic')).toBeUndefined();
    });

    it('one participant failing the carry-forward RPC does not stop others or reopen the cycle', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: true, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] },
          { id: 'p2', workspace_member_id: 'm2', contributor_targets: [{ target_amount: 50,  target_currency: 'USD', cycle_id: 'cycle-1', is_current: true }] },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // ledger: nobody paid anything
      mockSupabaseInstance.mockNextResponse({ data: { id: 'next-cycle-1', cycle_end: '2026-08-31' }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: null, error: { message: 'cross-currency carry-forward is not supported' } });
      mockSupabaseInstance.mockNextRpcResponse({ data: { applied: true, carried_amount: 50, new_target: { id: 't3', target_amount: 50 } }, error: null });

      await expect(runCycleLifecycle()).resolves.toBeUndefined();

      expect(mockSupabaseInstance.getRpcCalls().filter((c) => c.fnName === 'apply_cycle_carry_forward_atomic')).toHaveLength(2);
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ['m2'] }));
      expect(notification.send).not.toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ['m1'] }));
      // The cycle was NOT reopened for retry over one participant's failure
      // (that compensation path resets both status AND closed_at together).
      const reopen = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'open' && c.args[0]?.closed_at === null);
      expect(reopen).toBeUndefined();
    });

    it('re-enqueues generate-cycles for each closed cycle', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'cycle-1', container_id: 'c1', cycle_end: '2026-07-01', containers: { workspace_id: 'ws-1', carry_forward_unpaid: false, created_by: 'admin-1' } }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

      await runCycleLifecycle();

      expect(queueAddMock).toHaveBeenCalledWith('generate-cycles', { container_id: 'c1', generate_months_ahead: 3 });
    });
  });
});
