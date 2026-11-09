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

  describe('listContainers — includeDeleted', () => {
    it('defaults to only non-deleted containers (.is deleted_at null)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await containerService.listContainers({ workspaceId: WORKSPACE_ID, sortQuery: {} });

      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'deleted_at' && c.args[1] === null)).toBe(true);
      expect(calls.some((c) => c.method === 'not')).toBe(false);
    });

    it('includeDeleted: true queries only soft-deleted containers (.not deleted_at null)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await containerService.listContainers({ workspaceId: WORKSPACE_ID, sortQuery: {}, includeDeleted: true });

      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'not' && c.args[0] === 'deleted_at' && c.args[1] === 'is' && c.args[2] === null)).toBe(true);
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'deleted_at')).toBe(false);
    });

    it('includeDeleted: false behaves identically to omitting the flag', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: CONTAINER_ID, name: 'Party', status: 'active' }], error: null });

      const result = await containerService.listContainers({ workspaceId: WORKSPACE_ID, sortQuery: {}, includeDeleted: false });

      expect(result.containers).toHaveLength(1);
      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'is' && c.args[0] === 'deleted_at' && c.args[1] === null)).toBe(true);
    });
  });

  describe('container metadata reads', () => {
    const pagination = { page: 2, perPage: 10, offset: 10 };

    it('paginates filtered metadata without loading ledger, participant or public-link data', async () => {
      const rows = [{ id: CONTAINER_ID, name: 'Rent', container_type: 'recurring', status: 'active' }];
      mockSupabaseInstance.mockNextResponse({ data: rows, count: 31, error: null });
      await expect(containerService.listContainers({
        workspaceId: WORKSPACE_ID, typeFilter: 'recurring', statusFilter: 'active', sortQuery: { sort: '-name' }, pagination,
      })).resolves.toEqual({ containers: rows, count: 31 });
      const calls = mockSupabaseInstance.getCalls();
      expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', WORKSPACE_ID] });
      expect(calls).toContainEqual({ method: 'eq', args: ['container_type', 'recurring'] });
      expect(calls).toContainEqual({ method: 'eq', args: ['status', 'active'] });
      expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
      expect(calls).toContainEqual({ method: 'range', args: [10, 19] });
      expect(mockSupabaseInstance.builder.order.mock.calls).toEqual([['name', { ascending: false }], ['id', { ascending: true }]]);
      const [columns, options] = mockSupabaseInstance.builder.select.mock.calls[0];
      expect(columns).not.toMatch(/\*|ledger_entries|container_participants|public_token|files/);
      expect(options).toEqual({ count: 'exact' });
      expect(mockSupabaseInstance.client.from).toHaveBeenCalledTimes(1);
    });

    it('keeps the original unpaginated container summary shape for HTTP callers', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{
        id: CONTAINER_ID, name: 'Rent', status: 'active', container_participants: [{ id: 'p1' }],
        ledger_entries: [{ status: 'confirmed', base_amount: '10.50' }, { status: 'resolved', base_amount: '3.25' }, { status: 'pending', base_amount: '99.00' }],
      }], error: null });
      const result = await containerService.listContainers({ workspaceId: WORKSPACE_ID });
      expect(result).toEqual({ containers: [{
        id: CONTAINER_ID, name: 'Rent', status: 'active', container_participants: undefined, ledger_entries: undefined,
        participant_count: 1, total_confirmed_base: 13.75,
      }], meta: { total: 1, active_count: 1 } });
      expect(mockSupabaseInstance.builder.range).not.toHaveBeenCalled();
    });

    it.each([null, undefined, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects an unavailable exact list count: %j', async (count) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count, error: null });
      await expect(containerService.listContainers({ workspaceId: WORKSPACE_ID, pagination }))
        .rejects.toMatchObject({ code: 'CONTAINERS_UNAVAILABLE', statusCode: 503 });
    });

    it.each([
      { data: null, count: 0, error: null },
      { data: [], count: 0, error: { message: 'PRIVATE_DB_FAILURE' } },
    ])('rejects failed or missing list rows instead of reporting an empty workspace', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      const error = await containerService.listContainers({ workspaceId: WORKSPACE_ID, pagination }).catch((err) => err);
      expect(error).toMatchObject({ code: 'CONTAINERS_UNAVAILABLE', statusCode: 503 });
      expect(error.message).not.toContain('PRIVATE_');
    });

    it('reads a live container in the workspace without fetching related records in metadata mode', async () => {
      const row = { id: CONTAINER_ID, name: 'Rent', container_type: 'recurring', budget_target: '123456789012.34' };
      mockSupabaseInstance.mockNextResponse({ data: row, error: null });
      await expect(containerService.getContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, callerMemberId: 'member-1', metadataOnly: true }))
        .resolves.toEqual({ container: row });
      expect(mockSupabaseInstance.getCalls()).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'eq', args: ['id', CONTAINER_ID] },
        { method: 'is', args: ['deleted_at', null] },
      ]));
      const [columns] = mockSupabaseInstance.builder.select.mock.calls[0];
      expect(columns).toContain('budget_target');
      expect(columns).not.toMatch(/public_token|outcome_files|container_participants|ledger_entries|created_by/);
      expect(mockSupabaseInstance.client.from.mock.calls).toEqual([['containers']]);
    });

    it('retains the existing HTTP detail envelope, cycle and caller participation', async () => {
      const row = { id: CONTAINER_ID, container_type: 'recurring', enable_money: true, enable_tasks: false, container_participants: [{ id: 'p1' }] };
      const cycle = { id: 'cycle-1', status: 'open' };
      const participation = { id: 'p1', workspace_member_id: 'member-1' };
      mockSupabaseInstance.mockResponses({ data: row, error: null }, { data: cycle, error: null }, { data: participation, error: null });
      await expect(containerService.getContainer({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, callerMemberId: 'member-1' }))
        .resolves.toEqual({
          container: { id: CONTAINER_ID, container_type: 'recurring', enable_money: true, enable_tasks: false },
          current_cycle: cycle, current_user_participation: participation, participant_count: 1, money_enabled: true, tasks_enabled: false,
        });
      expect(mockSupabaseInstance.getCalls()).toContainEqual({ method: 'eq', args: ['workspace_member_id', 'member-1'] });
    });

    it('distinguishes a missing container from a failed container lookup', async () => {
      const args = { workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, callerMemberId: 'member-1', metadataOnly: true };
      mockSupabaseInstance.mockResponses({ data: null, error: null }, { data: null, error: { message: 'PRIVATE_DB_FAILURE' } });
      await expect(containerService.getContainer(args)).rejects.toBeInstanceOf(NotFoundError);
      await expect(containerService.getContainer(args)).rejects.toMatchObject({ code: 'CONTAINERS_UNAVAILABLE', statusCode: 503 });
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

  describe('listCycles', () => {
    const parameters = { workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, page: 2, perPage: 10, offset: 10 };

    it('checks the workspace parent before a counted, status-filtered cycle page', async () => {
      const cycles = [{ id: 'cycle-3', cycle_number: 3, total_expected: '100.50', total_collected: '20.00' }];
      mockSupabaseInstance.mockResponses(
        { data: { id: CONTAINER_ID }, error: null },
        { data: cycles, error: null, count: 31 },
      );
      await expect(containerService.listCycles({ ...parameters, statusFilter: 'open' })).resolves.toEqual({ cycles, count: 31 });

      const calls = mockSupabaseInstance.getCalls();
      const cycleStart = calls.findIndex((call) => call.method === 'from' && call.args[0] === 'container_cycles');
      expect(calls.slice(0, cycleStart)).toEqual(expect.arrayContaining([
        { method: 'select', args: ['id'] },
        { method: 'eq', args: ['id', CONTAINER_ID] },
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
        { method: 'is', args: ['deleted_at', null] },
      ]));
      expect(calls.slice(cycleStart)).toEqual(expect.arrayContaining([
        { method: 'select', args: ['*', { count: 'exact' }] },
        { method: 'eq', args: ['container_id', CONTAINER_ID] },
        { method: 'eq', args: ['status', 'open'] },
        { method: 'order', args: ['cycle_number', { ascending: false }] },
        { method: 'range', args: [10, 19] },
      ]));
    });

    it('does not query cycles if the workspace parent is missing, deleted, or belongs elsewhere', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      await expect(containerService.listCycles(parameters)).rejects.toBeInstanceOf(NotFoundError);
      expect(mockSupabaseInstance.client.from.mock.calls).toEqual([['containers']]);
    });

    it('returns a genuine empty page and count without adding a status filter', async () => {
      mockSupabaseInstance.mockResponses(
        { data: { id: CONTAINER_ID }, error: null },
        { data: [], error: null, count: 0 },
      );
      await expect(containerService.listCycles(parameters)).resolves.toEqual({ cycles: [], count: 0 });
      expect(mockSupabaseInstance.getCalls().some((call) => call.method === 'eq' && call.args[0] === 'status')).toBe(false);
    });

    it.each(['container', 'cycles'])('rejects a %s query failure without leaking database details', async (source) => {
      if (source === 'cycles') mockSupabaseInstance.mockNextResponse({ data: { id: CONTAINER_ID }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, count: null, error: { message: 'PRIVATE_DATABASE_DETAIL' } });
      await expect(containerService.listCycles(parameters)).rejects.toMatchObject({
        code: 'CYCLES_UNAVAILABLE', statusCode: 503, message: 'Billing cycles are unavailable. Please try again.',
      });
      expect(mockSupabaseInstance.client.from).toHaveBeenCalledTimes(source === 'container' ? 1 : 2);
    });

    it.each([
      { data: null, count: 0 }, { data: {}, count: 0 },
      { data: [], count: null }, { data: [], count: '0' },
      { data: [], count: -1 }, { data: [], count: 1.5 },
      { data: [], count: Number.MAX_SAFE_INTEGER + 1 },
    ])('rejects missing rows or an invalid exact count: %j', async (response) => {
      mockSupabaseInstance.mockResponses(
        { data: { id: CONTAINER_ID }, error: null },
        { ...response, error: null },
      );
      await expect(containerService.listCycles(parameters)).rejects.toMatchObject({ code: 'CYCLES_UNAVAILABLE', statusCode: 503 });
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
