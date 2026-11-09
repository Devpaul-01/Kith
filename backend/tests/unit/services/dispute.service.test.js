// tests/unit/services/dispute.service.test.js
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

const disputeService = require('../../../src/services/dispute.service');
const notification = require('../../../src/services/notification.service');
const audit = require('../../../src/services/audit.service');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../../../src/utils/errors');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';
const CONTAINER_ID = 'container-1';
const ACTOR_CTX = { workspaceId: WORKSPACE_ID, actorUserId: 'user-1', actorMemberId: 'member-1' };

describe('services/dispute.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    notification.send.mockResolvedValue();
    audit.log.mockResolvedValue();
  });

  describe('bounded agent reads', () => {
    const listArgs = { workspaceId: WORKSPACE_ID, statusFilter: 'open', page: 2, perPage: 10, offset: 10, metadataOnly: true };
    const detailArgs = { workspaceId: WORKSPACE_ID, disputeId: 'd1', isAdmin: false, callerId: 'caller-1', notesPagination: { page: 2, perPage: 1, offset: 1 } };
    const notes = [{ author_id: 'caller-1', note: 'First note', added_at: '2026-01-01' }, { author_id: 'admin-1', note: 'Second note', added_at: '2026-01-02' }];
    const detail = { id: 'd1', raised_by: 'caller-1', ledger_entry_id: 'e1', notes };

    it('scopes the list and its embedded records, preserves money and exact filtered counts, and excludes notes from selection', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'd1', ledger_entries: { original_amount: '5000.25', original_currency: 'NGN', base_amount: '5000.25', status: 'disputed' } }], count: 42, error: null });
      const result = await disputeService.listDisputes(listArgs);
      expect(result).toMatchObject({ disputes: [{ id: 'd1', original_amount: '5000.25', original_currency: 'NGN', base_amount: '5000.25', entry_status: 'disputed' }], count: 42 });
      const calls = mockSupabaseInstance.getCalls();
      expect(calls).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['ledger_entries.workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['raised_by_member.workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['resolved_by_member.workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['status', 'open'] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'range', args: [10, 19] },
      ]));
      const selection = calls.find((call) => call.method === 'select');
      expect(selection.args[1]).toEqual({ count: 'exact' });
      expect(selection.args[0]).not.toMatch(/\*|\bnotes\b/);
    });

    it('retains the legacy full list shape when metadataOnly is omitted', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [detail], count: 1, error: null });
      const { metadataOnly, ...httpArgs } = listArgs;
      expect((await disputeService.listDisputes(httpArgs)).disputes[0].notes).toEqual(notes);
      expect(mockSupabaseInstance.builder.select.mock.calls[0][0]).toContain('*');
    });

    it.each([null, undefined, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1])('rejects unavailable or invalid list counts: %j', async (count) => {
      mockSupabaseInstance.mockNextResponse({ data: [], count, error: null });
      await expect(disputeService.listDisputes(listArgs)).rejects.toMatchObject({ code: 'DISPUTES_UNAVAILABLE' });
    });

    it.each([{ data: null, count: 0, error: null }, { data: [], count: 0, error: { message: 'private database details' } }])('does not turn failed lists into an empty inbox', async (response) => {
      mockSupabaseInstance.mockNextResponse(response);
      await expect(disputeService.listDisputes(listArgs)).rejects.toMatchObject({ code: 'DISPUTES_UNAVAILABLE' });
    });

    it('paginates appended notes, counts the complete stored array and scopes the linked entry to the same workspace', async () => {
      mockSupabaseInstance.mockNextResponse({ data: detail, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', original_amount: '5000.25' }, error: null });
      const result = await disputeService.getDispute(detailArgs);
      expect(result).toMatchObject({ dispute: { notes: [notes[1]] }, notesCount: 2, entry: { id: 'e1', original_amount: '5000.25' } });
      const calls = mockSupabaseInstance.getCalls();
      expect(calls.filter((call) => call.method === 'eq' && call.args[0] === 'workspace_id')).toEqual([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
      ]);
      expect(calls).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['id', 'd1'] }, { method: 'eq', args: ['id', 'e1'] },
        { method: 'eq', args: ['contributor.workspace_id', WORKSPACE_ID] },
      ]));
      expect(calls.filter((call) => call.method === 'select').map((call) => call.args[0]).join(' ')).not.toMatch(/\*|proof_files|idempotency_key/);
    });

    it('rejects another raiser before fetching entry data or notes', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { ...detail, raised_by: 'other-member' }, error: null });
      await expect(disputeService.getDispute(detailArgs)).rejects.toBeInstanceOf(ForbiddenError);
      expect(mockSupabaseInstance.getCalls().filter((call) => call.method === 'from')).toEqual([{ method: 'from', args: ['disputes'] }]);
    });

    it.each([null, {}, [null], ['not a note object']])('fails closed when stored notes cannot be read: %j', async (invalidNotes) => {
      mockSupabaseInstance.mockNextResponse({ data: { ...detail, notes: invalidNotes }, error: null });
      await expect(disputeService.getDispute(detailArgs)).rejects.toMatchObject({ code: 'DISPUTES_UNAVAILABLE' });
    });

    it('distinguishes a missing linked entry from a failed linked-entry query', async () => {
      mockSupabaseInstance.mockNextResponse({ data: detail, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });
      await expect(disputeService.getDispute(detailArgs)).resolves.toHaveProperty('entry', null);
      mockSupabaseInstance.mockNextResponse({ data: detail, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'private database details' } });
      await expect(disputeService.getDispute(detailArgs)).rejects.toMatchObject({ code: 'DISPUTES_UNAVAILABLE' });
    });

    it('does not disguise failed dispute lookups as missing disputes', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'private database details' } });
      await expect(disputeService.getDispute(detailArgs)).rejects.toMatchObject({ code: 'DISPUTES_UNAVAILABLE' });
    });
  });

  describe('getDispute', () => {
    it('non-admin, not the raiser -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'someone-else' }, error: null });

      await expect(
        disputeService.getDispute({ workspaceId: WORKSPACE_ID, disputeId: 'd1', isAdmin: false, callerId: 'caller-1' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('non-admin, IS the raiser -> succeeds', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'caller-1', ledger_entry_id: 'e1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor: { display_name: 'Bob' } }, error: null });

      const result = await disputeService.getDispute({ workspaceId: WORKSPACE_ID, disputeId: 'd1', isAdmin: false, callerId: 'caller-1' });

      expect(result.dispute.id).toBe('d1');
    });

    it('dispute not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        disputeService.getDispute({ workspaceId: WORKSPACE_ID, disputeId: 'missing', isAdmin: true, callerId: 'admin-1' })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('.maybeSingle() + explicit 404 on the referenced entry lookup instead of a raw error (entry deleted after dispute raised)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'admin-1', ledger_entry_id: 'gone' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: null, error: null }); // entry no longer exists

      const result = await disputeService.getDispute({ workspaceId: WORKSPACE_ID, disputeId: 'd1', isAdmin: true, callerId: 'admin-1' });

      expect(result.entry).toBeNull();
    });
  });

  describe('raiseDispute', () => {
    it('ledger entry not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        disputeService.raiseDispute({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'missing', reason: 'bad', callerId: 'caller-1', isAdmin: false, actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('non-admin disputing someone else\'s entry -> ForbiddenError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: 'someone-else', status: 'confirmed' }, error: null });

      await expect(
        disputeService.raiseDispute({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1', reason: 'bad', callerId: 'caller-1', isAdmin: false, actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('cannot dispute an already-disputed entry', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: 'caller-1', status: 'disputed' }, error: null });

      await expect(
        disputeService.raiseDispute({ workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1', reason: 'bad', callerId: 'caller-1', isAdmin: false, actorDisplayName: 'Bob', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: calls raise_dispute_atomic with correct params and notifies admins', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'e1', contributor_id: 'caller-1', status: 'confirmed', original_amount: 50, original_currency: 'USD' }, error: null });
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'dispute-1' }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'admin-1' }], error: null });

      const result = await disputeService.raiseDispute({
        workspaceId: WORKSPACE_ID, containerId: CONTAINER_ID, entryId: 'e1', reason: 'looks wrong',
        callerId: 'caller-1', isAdmin: false, actorDisplayName: 'Bob', actorCtx: ACTOR_CTX,
      });

      const rpcCall = mockSupabaseInstance.getRpcCalls()[0];
      expect(rpcCall.fnName).toBe('raise_dispute_atomic');
      expect(rpcCall.params).toEqual({
        p_workspace_id: WORKSPACE_ID, p_ledger_entry_id: 'e1', p_raised_by: 'caller-1', p_reason: 'looks wrong',
      });
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ recipientIds: ['admin-1'] }));
      expect(result.entry.status).toBe('disputed');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispute.raised' }));
    });
  });

  describe('addDisputeNote — no route-level role restriction, service is the sole enforcement point', () => {
    it('a third, unrelated non-admin caller cannot add a note', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'original-raiser', notes: [] }, error: null });

      await expect(
        disputeService.addDisputeNote({ workspaceId: WORKSPACE_ID, disputeId: 'd1', note: 'x', isAdmin: false, callerId: 'unrelated-member' })
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('the original raiser can add a note', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'caller-1', notes: [] }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', notes: [{ note: 'x' }] }, error: null });

      const result = await disputeService.addDisputeNote({ workspaceId: WORKSPACE_ID, disputeId: 'd1', note: 'x', isAdmin: false, callerId: 'caller-1' });

      expect(result.notes).toHaveLength(1);
    });

    it('appends to existing notes rather than replacing them', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', raised_by: 'admin-1', notes: [{ note: 'first' }] }, error: null });
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', notes: [{ note: 'first' }, { note: 'second' }] }, error: null });

      await disputeService.addDisputeNote({ workspaceId: WORKSPACE_ID, disputeId: 'd1', note: 'second', isAdmin: true, callerId: 'admin-1' });

      const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
      expect(updateCall.args[0].notes).toHaveLength(2);
    });
  });

  describe('resolveDispute', () => {
    it('dispute not found -> NotFoundError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null });

      await expect(
        disputeService.resolveDispute({ workspaceId: WORKSPACE_ID, disputeId: 'missing', resolutionNote: 'fixed', resolvedByMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('already-resolved dispute -> BusinessRuleError', async () => {
      mockSupabaseInstance.mockNextResponse({ data: { id: 'd1', status: 'resolved' }, error: null });

      await expect(
        disputeService.resolveDispute({ workspaceId: WORKSPACE_ID, disputeId: 'd1', resolutionNote: 'fixed', resolvedByMemberId: 'admin-1', actorCtx: ACTOR_CTX })
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it('success: calls resolve_dispute_atomic and notifies the original raiser', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'd1', status: 'open', raised_by: 'caller-1', ledger_entries: { container_id: CONTAINER_ID, containers: { name: 'Party' } } },
        error: null,
      });
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'd1', status: 'resolved' }, error: null });

      const result = await disputeService.resolveDispute({
        workspaceId: WORKSPACE_ID, disputeId: 'd1', resolutionNote: 'fixed', resolvedByMemberId: 'admin-1', actorCtx: ACTOR_CTX,
      });

      expect(result.status).toBe('resolved');
      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'dispute_resolved', recipientIds: ['caller-1'], variables: { container: 'Party' },
      }));
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispute.resolved' }));
    });

    it('falls back to "a container" when the container name cannot be resolved', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: { id: 'd1', status: 'open', raised_by: 'caller-1', ledger_entries: null },
        error: null,
      });
      mockSupabaseInstance.mockNextRpcResponse({ data: { id: 'd1' }, error: null });

      await disputeService.resolveDispute({ workspaceId: WORKSPACE_ID, disputeId: 'd1', resolutionNote: 'fixed', resolvedByMemberId: 'admin-1', actorCtx: ACTOR_CTX });

      expect(notification.send).toHaveBeenCalledWith(expect.objectContaining({ variables: { container: 'a container' } }));
    });
  });
});
