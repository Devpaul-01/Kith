// tests/unit/services/export.service.test.js
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

const { exportLedgerCSV, exportTasksCSV } = require('../../../src/services/export.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/export.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  describe('exportLedgerCSV', () => {
    it('produces a header row and correctly quoted data row', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{
          id: 'e1', entry_type: 'contribution', original_amount: 50, original_currency: 'USD', base_amount: 50,
          payment_method: 'cash', status: 'confirmed', note: 'x', recorded_at: '2026-01-01', confirmed_at: '2026-01-02',
          contributor: { display_name: 'Alice, "The Organizer"' }, recorded_by_member: { display_name: 'Bob' }, container: { name: 'Party' },
        }],
        error: null,
      });

      const csv = await exportLedgerCSV({ workspaceId: 'ws-1' });

      expect(csv).toContain('Entry ID,Container,Type,Contributor');
      expect(csv).toContain('"Alice, ""The Organizer"""');
    });

    it('applies containerId/from/to filters when provided', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await exportLedgerCSV({ workspaceId: 'ws-1', containerId: 'c1', from: '2026-01-01', to: '2026-02-01' });

      const calls = mockSupabaseInstance.getCalls();
      expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'container_id' && c.args[1] === 'c1')).toBe(true);
      expect(calls.some((c) => c.method === 'gte' && c.args[0] === 'recorded_at')).toBe(true);
      expect(calls.some((c) => c.method === 'lte' && c.args[0] === 'recorded_at')).toBe(true);
    });

    it('throws on query error', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'query failed' } });

      await expect(exportLedgerCSV({ workspaceId: 'ws-1' })).rejects.toThrow('query failed');
    });

    it('handles missing nested joins gracefully', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 'e1', entry_type: 'contribution', original_amount: 50, original_currency: 'USD', base_amount: 50, status: 'confirmed' }],
        error: null,
      });

      const csv = await exportLedgerCSV({ workspaceId: 'ws-1' });

      expect(csv).toContain('e1');
    });
  });

  describe('exportTasksCSV', () => {
    it('scopes to assignedTo when provided (member-scoped export)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await exportTasksCSV({ containerId: 'c1', assignedTo: 'm1' });

      const eqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'assigned_to');
      expect(eqCall.args[1]).toBe('m1');
    });

    it('does not scope by assignedTo when null (admin export)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      await exportTasksCSV({ containerId: 'c1', assignedTo: null });

      const eqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'assigned_to');
      expect(eqCall).toBeUndefined();
    });

    it('produces correctly escaped CSV output for special characters in titles', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ id: 't1', title: 'Buy "supplies", now', description: null, due_date: null, status: 'pending', completed_at: null, completion_note: null, assigned_to_member: { display_name: 'Bob' } }],
        error: null,
      });

      const csv = await exportTasksCSV({ containerId: 'c1' });

      expect(csv).toContain('"Buy ""supplies"", now"');
    });

    it('throws on query error', async () => {
      mockSupabaseInstance.mockNextResponse({ data: null, error: { message: 'task query failed' } });

      await expect(exportTasksCSV({ containerId: 'c1' })).rejects.toThrow('task query failed');
    });
  });
});
