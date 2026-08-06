// tests/unit/services/container.service.test.js
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
jest.mock('../../../src/services/audit.service');
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/queues');

const containerService = require('../../../src/services/container.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { getQueue } = require('../../../src/queues');
const { NotFoundError, BusinessRuleError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'member-1' };

describe('services/container.service', () => {
  let queueAddMock;

  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
    queueAddMock = jest.fn().mockResolvedValue({ id: 'job-1' });
    getQueue.mockReturnValue({ add: queueAddMock });
  });

  describe('createContainer', () => {
    it('recurring container -> enqueues cycle generation', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'Rent', container_type: 'recurring' }, error: null });

      await containerService.createContainer({
        workspaceId: WORKSPACE_ID,
        data: { name: 'Rent', container_type: 'recurring' },
        actorMemberId: 'member-1',
        actorCtx: ACTOR_CTX,
      });

      expect(queueAddMock).toHaveBeenCalledWith(
        'generate-cycles',
        { container_id: CONTAINER_ID, generate_months_ahead: 3 },
        { attempts: 3 }
      );
    });

    it('event container -> does NOT enqueue cycle generation', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'Party', container_type: 'event' }, error: null });

      await containerService.createContainer({
        workspaceId: WORKSPACE_ID,
        data: { name: 'Party', container_type: 'event' },
        actorMemberId: 'member-1',
        actorCtx: ACTOR_CTX,
      });

      expect(queueAddMock).not.toHaveBeenCalled();
    });

    it('queue-add failure does NOT fail container creation (caught, logged)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'Rent', container_type: 'recurring' }, error: null });
      queueAddMock.mockRejectedValueOnce(new Error('queue down'));

      await expect(
        containerService.createContainer({
          workspaceId: WORKSPACE_ID,
          data: { name: 'Rent', container_type: 'recurring' },
          actorMemberId: 'member-1',
          actorCtx: ACTOR_CTX,
        })
      ).resolves.toBeDefined();
    });

    it('writes an audit log entry with name and container_type metadata', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'Party', container_type: 'event' }, error: null });

      await containerService.createContainer({
        workspaceId: WORKSPACE_ID, data: { name: 'Party', container_type: 'event' },
        actorMemberId: 'member-1', actorCtx: ACTOR_CTX,
      });

      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'container.created',
        metadata: { name: 'Party', container_type: 'event' },
      }));
    });
  });

  describe('updateContainer — fail-closed count-query guard (Issue C6)', () => {
    it('rejects disabling money tracking when confirmed ledger entries exist (count > 0)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, enable_money: true }, error: null }); // fetch current
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 3 }); // count query: entries exist

      await expect(
        containerService.updateContainer({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          data: { enable_money: false }, actorCtx: ACTOR_CTX,
        })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('FAILS LOUD (throws) when the count-query itself errors, rather than silently proceeding', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, enable_money: true }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'count query failed' }, count: undefined });

      await expect(
        containerService.updateContainer({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          data: { enable_money: false }, actorCtx: ACTOR_CTX,
        })
      ).rejects.toThrow('count query failed');
    });

    it('allows disabling money tracking when no ledger entries exist (count 0)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, enable_money: true }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, enable_money: false }, error: null }); // update

      await expect(
        containerService.updateContainer({
          workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
          data: { enable_money: false }, actorCtx: ACTOR_CTX,
        })
      ).resolves.toEqual({ id: CONTAINER_ID, enable_money: false });
    });

    it('the guard does NOT fire when enable_money is not being changed to false', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, enable_money: true, name: 'Old' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'New' }, error: null }); // update

      await containerService.updateContainer({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { name: 'New' }, actorCtx: ACTOR_CTX,
      });

      const countCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'from' && c.args[0] === 'ledger_entries');
      expect(countCalls.length).toBe(0);
    });

    it('container not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        containerService.updateContainer({ workspaceId: WORKSPACE_ID, containerId: 'missing', data: { name: 'X' }, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('empty diff -> returns current row, no update call', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, name: 'X' }, error: null });

      const result = await containerService.updateContainer({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorCtx: ACTOR_CTX,
      });

      expect(result).toEqual({ id: CONTAINER_ID, name: 'X' });
      const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
      expect(updateCalls.length).toBe(0);
    });
  });

  describe('completeContainer', () => {
    it('rejects completing a non-active container', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, status: 'completed', name: 'X' }, error: null });

      await expect(
        containerService.completeContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorMemberId: 'm1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('milestone auto-creation failure does NOT fail the completion', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, status: 'active', name: 'Party' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, status: 'completed' }, error: null }); // update
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'milestone insert failed' } }); // milestone insert
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // participants

      await expect(
        containerService.completeContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorMemberId: 'm1', actorCtx: ACTOR_CTX })
      ).resolves.toEqual({ id: CONTAINER_ID, status: 'completed' });
    });

    it('notifies all participants on completion', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, status: 'active', name: 'Party' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, status: 'completed' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // milestone insert
      mockSupabaseInstance.mockNextResponse({ data: [{ workspace_member_id: 'p1' }, { workspace_member_id: 'p2' }], error: null });

      await containerService.completeContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorMemberId: 'm1', actorCtx: ACTOR_CTX });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'container_completed',
        recipientIds: ['p1', 'p2'],
      }));
    });
  });

  describe('convertToRecurring — atomic RPC boundary', () => {
    it('rejects converting a non-event container', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, container_type: 'recurring', status: 'active' }, error: null });

      await expect(
        containerService.convertToRecurring({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorMemberId: 'm1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('rejects converting an archived container (not active/completed)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, container_type: 'event', status: 'archived' }, error: null });

      await expect(
        containerService.convertToRecurring({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, data: {}, actorMemberId: 'm1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('calls convert_event_to_recurring_atomic with correctly mapped parameters', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, container_type: 'event', status: 'active', name: 'Party' }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'new-container-1' }, error: null });

      await containerService.convertToRecurring({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', carry_forward_unpaid: true },
        actorMemberId: 'm1', actorCtx: ACTOR_CTX,
      });

      const rpcCall = mockSupabaseInstance.getRpcCalls()[0];
      expect(rpcCall.fnName).toBe('convert_event_to_recurring_atomic');
      expect(rpcCall.params).toEqual(expect.objectContaining({
        p_source_container_id: CONTAINER_ID,
        p_workspace_id: WORKSPACE_ID,
        p_new_name: 'Party',
        p_recurrence_cadence: 'monthly',
        p_recurrence_start: '2026-01-01',
        p_carry_forward_unpaid: true,
        p_created_by: 'm1',
      }));
    });

    it('enqueues cycle generation for the new container on success', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID, container_type: 'event', status: 'active', name: 'Party' }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'new-container-1' }, error: null });

      await containerService.convertToRecurring({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        data: { recurrence_cadence: 'monthly', recurrence_start: '2026-01-01' },
        actorMemberId: 'm1', actorCtx: ACTOR_CTX,
      });

      expect(queueAddMock).toHaveBeenCalledWith(
        'generate-cycles',
        { container_id: 'new-container-1', generate_months_ahead: 3 },
        { attempts: 3 }
      );
    });
  });

  describe('deleteContainer', () => {
    it('rejects deleting a container with confirmed ledger entries', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 2 });

      await expect(
        containerService.deleteContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('succeeds (soft delete) when no confirmed entries exist', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // soft-delete update

      await expect(
        containerService.deleteContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, actorCtx: ACTOR_CTX })
      ).resolves.toBeUndefined();
    });
  });

  describe('restoreContainer', () => {
    it('throws NotFoundError when no soft-deleted row matches', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        containerService.restoreContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('getSummary — participant status derivation (all 5 states)', () => {
    const containerRow = { id: CONTAINER_ID, name: 'Party', status: 'active', budget_target: 1000, budget_currency: 'USD', enable_money: true };

    function mockParticipantScenario(currentTarget, ledgerEntries) {
      mockSupabaseInstance.mockNextResponse({ data: containerRow, error: null });
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'p1', role: null, money_enabled: true, workspace_member_id: 'member-1', added_by: null,
          workspace_members: { display_name: 'Bob', is_proxy: false },
          contributor_targets: currentTarget ? [{ ...currentTarget, is_current: true, cycle_id: null }] : [],
        }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: ledgerEntries, error: null });
    }

    it('no_target: participant has no current target', async () => {
      mockParticipantScenario(null, []);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.participants[0].status).toBe('no_target');
    });

    it('paid: confirmed >= target', async () => {
      mockParticipantScenario({ target_amount: 100, target_currency: 'USD', due_date: null }, [
        { contributor_id: 'member-1', base_amount: 100, status: 'confirmed' },
      ]);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.participants[0].status).toBe('paid');
    });

    it('partial: 0 < confirmed < target', async () => {
      mockParticipantScenario({ target_amount: 100, target_currency: 'USD', due_date: null }, [
        { contributor_id: 'member-1', base_amount: 50, status: 'confirmed' },
      ]);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.participants[0].status).toBe('partial');
    });

    it('overdue: confirmed=0, due_date in the past', async () => {
      mockParticipantScenario({ target_amount: 100, target_currency: 'USD', due_date: '2020-01-01' }, []);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.participants[0].status).toBe('overdue');
    });

    it('pending: confirmed=0, due_date in the future (or none)', async () => {
      mockParticipantScenario({ target_amount: 100, target_currency: 'USD', due_date: '2099-01-01' }, []);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.participants[0].status).toBe('pending');
    });

    it('progress_pct is null (not NaN) when totalExpected is 0', async () => {
      mockParticipantScenario(null, []);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: true, callerId: 'admin-1' });
      expect(result.progress_pct).toBeNull();
    });

    it('non-admin, non-self caller sees only the reduced shape (no financial fields)', async () => {
      mockParticipantScenario({ target_amount: 100, target_currency: 'USD', due_date: null }, [
        { contributor_id: 'member-1', base_amount: 100, status: 'confirmed' },
      ]);
      const result = await containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, isAdmin: false, callerId: 'someone-else' });

      const p = result.participants[0];
      expect(Object.keys(p).sort()).toEqual(['display_name', 'is_proxy', 'member_id', 'role', 'status'].sort());
      expect(p).not.toHaveProperty('confirmed_paid_base');
    });

    it('container not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        containerService.getSummary({ workspaceId: WORKSPACE_ID, containerId: 'missing', isAdmin: true, callerId: 'admin-1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('getPublicContainer', () => {
    it('throws NotFoundError for an unknown public token', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        containerService.getPublicContainer({ publicToken: 'unknown' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('omits the contributors key entirely when public_show_names is false', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: CONTAINER_ID, name: 'Party', public_show_names: false, workspaces: { name: 'The Smiths' } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // ledger

      const result = await containerService.getPublicContainer({ publicToken: 'tok' });

      expect(result).not.toHaveProperty('contributors');
    });

    it('includes contributors with paid/pending status when public_show_names is true', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: CONTAINER_ID, name: 'Party', public_show_names: true, budget_target: 100, workspaces: { name: 'The Smiths' } },
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'p1', base_amount: 50 }], error: null }); // ledger
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'p1', workspace_members: { display_name: 'Bob' }, contributor_targets: [{ target_amount: 50, is_current: true }] }],
        error: null,
      });

      const result = await containerService.getPublicContainer({ publicToken: 'tok' });

      expect(result.contributors).toEqual([{ display_name: 'Bob', status: 'paid' }]);
    });
  });
});
