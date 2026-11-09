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

    it('returns a typed unavailable error when the query fails', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'query failed' }, count: 0 });

      await expect(
        getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 })
      ).rejects.toMatchObject({ code: 'AUDIT_LOG_UNAVAILABLE', statusCode: 503 });
    });

    it('fails closed when the exact count is unavailable', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await expect(getAuditLog({ workspaceId: WORKSPACE_ID, filters: {}, page: 1, perPage: 20, offset: 0 }))
        .rejects.toMatchObject({ code: 'AUDIT_LOG_UNAVAILABLE' });
    });

    it('selects only event fields for summaries and scopes embedded actors without attributing missing names to System', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [
        { id: 'a1', actor_member_id: 'm1', actor_member: { display_name: 'Ada' } },
        { id: 'a2', actor_member_id: 'm2', actor_member: null },
        { id: 'a3', actor_member_id: null, actor_member: null },
      ], count: 30, error: null });
      const result = await getAuditLog({ workspaceId: WORKSPACE_ID, page: 2, perPage: 10, offset: 10, summaryOnly: true });
      expect(result.entries.map((entry) => entry.actor_name)).toEqual(['Ada', null, null]);
      expect(result.count).toBe(30);
      const calls = mockSupabaseInstance.getCalls();
      const selection = calls.find((call) => call.method === 'select');
      expect(selection.args[0]).not.toMatch(/\*|metadata|actor_user_id|ip_address|user_agent/);
      expect(selection.args[1]).toEqual({ count: 'exact' });
      expect(calls).toEqual(expect.arrayContaining([
        { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
        { method: 'eq', args: ['actor_member.workspace_id', WORKSPACE_ID] },
        { method: 'order', args: ['created_at', { ascending: false }] },
        { method: 'order', args: ['id', { ascending: true }] },
        { method: 'range', args: [10, 19] },
      ]));
    });

    it.each([null, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid counts rather than inventing totals: %j', async (count) => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null, count });
      await expect(getAuditLog({ workspaceId: WORKSPACE_ID, page: 1, perPage: 20, offset: 0, summaryOnly: true }))
        .rejects.toMatchObject({ code: 'AUDIT_LOG_UNAVAILABLE' });
    });

    it('does not interpret a missing row array as an empty audit log', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: null, count: 0 });
      await expect(getAuditLog({ workspaceId: WORKSPACE_ID, page: 1, perPage: 20, offset: 0, summaryOnly: true }))
        .rejects.toMatchObject({ code: 'AUDIT_LOG_UNAVAILABLE' });
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
