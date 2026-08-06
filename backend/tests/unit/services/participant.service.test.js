// tests/unit/services/participant.service.test.js
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
jest.mock('../../../src/services/audit.service');

const participantService = require('../../../src/services/participant.service');
const audit = require('../../../src/services/audit.service');
const { NotFoundError, BusinessRuleError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'admin-1' };

describe('services/participant.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    audit.log.mockResolvedValue();
  });

  describe('addParticipants — target auto-creation matrix (4 combinations)', () => {
    it('container not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        participantService.addParticipants({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, participants: [{ workspace_member_id: 'm1' }], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('cannot add participants to a non-active container', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: true, enable_tasks: false, status: 'completed' }, error: null });

      await expect(
        participantService.addParticipants({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, participants: [{ workspace_member_id: 'm1' }], actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('enable_money=true + target.amount>0 -> creates a contributor_target row', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: true, enable_tasks: false, status: 'active' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null }); // valid members
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1' }], error: null }); // upsert
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // contributor_targets insert

      await participantService.addParticipants({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        participants: [{ workspace_member_id: 'm1', target: { amount: 100, currency: 'USD' } }],
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const targetInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'from' && c.args[0] === 'contributor_targets');
      expect(targetInsert).toBeDefined();
    });

    it('enable_money=false -> does NOT create a target even if target.amount>0 is provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: false, enable_tasks: false, status: 'active' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1' }], error: null });

      await participantService.addParticipants({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        participants: [{ workspace_member_id: 'm1', target: { amount: 100, currency: 'USD' } }],
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const targetInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'from' && c.args[0] === 'contributor_targets');
      expect(targetInsert).toBeUndefined();
    });

    it('enable_money=true but no target provided -> no target created', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: true, enable_tasks: false, status: 'active' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1' }], error: null });

      await participantService.addParticipants({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        participants: [{ workspace_member_id: 'm1' }],
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const targetInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'from' && c.args[0] === 'contributor_targets');
      expect(targetInsert).toBeUndefined();
    });

    it('enable_money=true + target.amount=0 -> no target created (not > 0)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: true, enable_tasks: false, status: 'active' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1' }], error: null });

      await participantService.addParticipants({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        participants: [{ workspace_member_id: 'm1', target: { amount: 0, currency: 'USD' } }],
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const targetInsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'from' && c.args[0] === 'contributor_targets');
      expect(targetInsert).toBeUndefined();
    });

    it('invalid member IDs are silently skipped, valid ones added', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { enable_money: false, enable_tasks: false, status: 'active' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'valid-1' }], error: null }); // only valid-1 is a real member

      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'valid-1' }], error: null });

      const result = await participantService.addParticipants({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID,
        participants: [{ workspace_member_id: 'valid-1' }, { workspace_member_id: 'invalid-1' }],
        actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      expect(result.skipped_invalid_member).toBe(1);
      expect(result.added).toHaveLength(1);
    });
  });

  describe('updateParticipant — money_enabled guard mirrors container-level guard', () => {
    it('rejects disabling money tracking when confirmed entries exist', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { workspace_member_id: 'm1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 1 });

      await expect(
        participantService.updateParticipant({ containerId: CONTAINER_ID, participantId: 'p1', data: { money_enabled: false } })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('allows disabling money tracking with no confirmed entries', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { workspace_member_id: 'm1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p1', money_enabled: false }, error: null });

      await expect(
        participantService.updateParticipant({ containerId: CONTAINER_ID, participantId: 'p1', data: { money_enabled: false } })
      ).resolves.toEqual({ id: 'p1', money_enabled: false });
    });

    it('participant not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        participantService.updateParticipant({ containerId: CONTAINER_ID, participantId: 'missing', data: { role: 'x' } })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('removeParticipant', () => {
    it('rejects removing a participant with confirmed ledger entries', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'p1', workspace_member_id: 'm1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 1 });

      await expect(
        participantService.removeParticipant({ containerId: CONTAINER_ID, participantId: 'p1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  describe('setTarget — atomic RPC boundary', () => {
    it('rejects when container does not have money tracking enabled', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { workspace_member_id: 'm1', containers: { enable_money: false } }, error: null });

      await expect(
        participantService.setTarget({ containerId: CONTAINER_ID, participantId: 'p1', amount: 50, currency: 'USD', actorMemberId: 'admin-1' })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('calls set_contributor_target_atomic with correct params and returns new/previous target', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { workspace_member_id: 'm1', containers: { enable_money: true } }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { new_target: { amount: 100 }, previous_target: { amount: 50 } }, error: null });

      const result = await participantService.setTarget({ containerId: CONTAINER_ID, participantId: 'p1', amount: 100, currency: 'USD', due_date: '2026-01-01', actorMemberId: 'admin-1' });

      const rpcCall = mockSupabaseInstance.getRpcCalls()[0];
      expect(rpcCall.fnName).toBe('set_contributor_target_atomic');
      expect(rpcCall.params).toEqual({
        p_container_participant_id: 'p1', p_container_id: CONTAINER_ID, p_workspace_member_id: 'm1',
        p_target_amount: 100, p_target_currency: 'USD', p_due_date: '2026-01-01', p_set_by: 'admin-1',
      });
      expect(result).toEqual({ target: { amount: 100 }, previous_target: { amount: 50 } });
    });
  });

  describe('getCycleTargets — all 4 cycle-target status states', () => {
    const participantRow = { workspace_member_id: 'm1', workspace_members: { display_name: 'Bob' } };

    it('skipped: no target for the cycle', async () => {
      mockSupabaseInstance.mockNextResponse({ data: participantRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', cycle_number: 1, status: 'open' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no cycle targets
      mockSupabaseInstance.mockNextResponse({ data: [], error: null }); // no ledger

      const result = await participantService.getCycleTargets({ containerId: CONTAINER_ID, participantId: 'p1' });
      expect(result.cycle_targets[0].status).toBe('skipped');
    });

    it('paid: confirmed >= target', async () => {
      mockSupabaseInstance.mockNextResponse({ data: participantRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', cycle_number: 1, status: 'open' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', cycle_id: 'c1', target_amount: 100 }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ cycle_id: 'c1', base_amount: 100 }], error: null });

      const result = await participantService.getCycleTargets({ containerId: CONTAINER_ID, participantId: 'p1' });
      expect(result.cycle_targets[0].status).toBe('paid');
    });

    it('partial: 0 < confirmed < target', async () => {
      mockSupabaseInstance.mockNextResponse({ data: participantRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', cycle_number: 1, status: 'open' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', cycle_id: 'c1', target_amount: 100 }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ cycle_id: 'c1', base_amount: 30 }], error: null });

      const result = await participantService.getCycleTargets({ containerId: CONTAINER_ID, participantId: 'p1' });
      expect(result.cycle_targets[0].status).toBe('partial');
    });

    it('overdue: confirmed=0, cycle is closed', async () => {
      mockSupabaseInstance.mockNextResponse({ data: participantRow, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', cycle_number: 1, status: 'closed' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 't1', cycle_id: 'c1', target_amount: 100 }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await participantService.getCycleTargets({ containerId: CONTAINER_ID, participantId: 'p1' });
      expect(result.cycle_targets[0].status).toBe('overdue');
    });

    it('participant not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        participantService.getCycleTargets({ containerId: CONTAINER_ID, participantId: 'missing' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('overrideCycle', () => {
    it('cycle not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        participantService.overrideCycle({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'missing', data: { override_type: 'pause_pool' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('cannot override a closed cycle', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'c1', status: 'closed', cycle_start: '2026-01-01' }, error: null });

      await expect(
        participantService.overrideCycle({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'c1', data: { override_type: 'pause_pool' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('skip_member override requires member_id', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'c1', status: 'open', cycle_start: '2026-01-01' }, error: null });

      await expect(
        participantService.overrideCycle({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'c1', data: { override_type: 'skip_member' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toThrow('member_id required for skip_member override');
    });

    it('adjust_target override requires new_target', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'c1', status: 'open', cycle_start: '2026-01-01' }, error: null });

      await expect(
        participantService.overrideCycle({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'c1', data: { override_type: 'adjust_target' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toThrow('new_target required for adjust_target override');
    });

    it('pause_pool override marks the cycle as skipped', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'c1', status: 'open', cycle_start: '2026-01-01' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'override-1' }, error: null }); // override insert
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // cycle status update

      await participantService.overrideCycle({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'c1',
        data: { override_type: 'pause_pool' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const statusUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update' && c.args[0]?.status === 'skipped');
      expect(statusUpdate).toBeDefined();
    });

    it('non-pause_pool override does NOT touch cycle status', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'c1', status: 'open', cycle_start: '2026-01-01' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'override-1' }, error: null });

      await participantService.overrideCycle({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, cycleId: 'c1',
        data: { override_type: 'skip_member', member_id: 'm1' }, actorMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      const statusUpdate = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(statusUpdate).toBeUndefined();
    });
  });
});
