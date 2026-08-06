// tests/unit/services/audit_log.service.test.js
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

const { getAuditLog, exportAuditLogCsv } = require('../../../src/services/audit_log.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';

describe('services/audit_log.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  describe('getAuditLog', () => {
    it('resolves actor_name from the joined member, falling back to "System"', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { id: 'a1', action: 'x', actor_member: { display_name: 'Bob' } },
          { id: 'a2', action: 'y', actor_member: null },
        ],
        error: null,
        count: 2,
      });

      const result = await getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 });

      expect(result.entries[0].actor_name).toBe('Bob');
      expect(result.entries[1].actor_name).toBe('System');
      expect(result.entries[0].actor_member).toBeUndefined();
    });

    it('applies action/actor_member_id/from/to filters when provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await getAuditLog({
        workspaceId: WORKSPACE_ID,
        filters: { action: 'ledger.confirmed', actor_member_id: 'm1', from: '2026-01-01', to: '2026-02-01' },
        page: 1, perPage: 20, offset: 0,
      });

      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'action' && c.args[1] === 'ledger.confirmed')).toBe(true);
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'actor_member_id' && c.args[1] === 'm1')).toBe(true);
      expect(calls.some((c) => c.method === 'gte' && c.args[0] === 'created_at' && c.args[1] === '2026-01-01')).toBe(true);
      expect(calls.some((c) => c.method === 'lte' && c.args[0] === 'created_at' && c.args[1] === '2026-02-01')).toBe(true);
    });

    it('skips filters that are not provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count: 0 });

      await getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 });

      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'action')).toBe(false);
    });

    it('throws a plain Error when the query errors', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'query failed' }, count: 0 });

      await expect(
        getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 })
      ).rejects.toThrow('query failed');
    });

    it('defaults count to 0 when the response omits it', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 });

      expect(result.count).toBe(0);
    });
  });

  describe('exportAuditLogCsv', () => {
    it('produces a CSV with header row and correctly quoted/escaped fields', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{
          created_at: '2026-01-01', action: 'member.created',
          actor_member: { display_name: 'Alice, "The Organizer"' },
          target_type: 'workspace_member', target_id: 'm1', metadata: { note: 'hi' },
        }],
        error: null,
      });

      const csv = await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {} });

      expect(csv).toContain('Date,Action,Actor,Target Type,Target ID,Metadata');
      // Embedded double-quotes must be escaped as "" and the whole field quoted,
      // so the comma inside the name does not break column alignment.
      expect(csv).toContain('"Alice, ""The Organizer"""');
    });

    it('falls back to "System" for entries with no actor_member', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ created_at: '2026-01-01', action: 'x', actor_member: null, target_type: null, target_id: null, metadata: null }],
        error: null,
      });

      const csv = await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {} });

      expect(csv).toContain('"System"');
    });

    describe('Doc 1 Bug Review Finding #5: limit edge cases', () => {
      it('non-numeric limit ("abc") -> Math.min(NaN, 10000) = NaN passed to .limit() (documents current behavior)', async () => {
        mockSupabaseInstance.mockNextResponse({ data: [], error: null });

        await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {}, limit: 'abc' });

        const limitCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'limit');
        expect(Number.isNaN(limitCall.args[0])).toBe(true);
      });

      it('negative limit (-5) -> Math.min(-5, 10000) = -5 passed to .limit() (documents current behavior, no floor)', async () => {
        mockSupabaseInstance.mockNextResponse({ data: [], error: null });

        await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {}, limit: -5 });

        const limitCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'limit');
        expect(limitCall.args[0]).toBe(-5);
      });

      it('limit above 10000 is clamped down to 10000', async () => {
        mockSupabaseInstance.mockNextResponse({ data: [], error: null });

        await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {}, limit: 999999 });

        const limitCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'limit');
        expect(limitCall.args[0]).toBe(10000);
      });

      it('defaults to 1000 when omitted', async () => {
        mockSupabaseInstance.mockNextResponse({ data: [], error: null });

        await exportAuditLogCsv({ workspaceId: WORKSPACE_ID, filters: {} });

        const limitCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'limit');
        expect(limitCall.args[0]).toBe(1000);
      });
    });
  });
});
