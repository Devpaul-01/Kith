// tests/unit/services/engagement.service.test.js
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

const { fetchEngagementData, computeEngagement } = require('../../../src/services/engagement.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/engagement.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  describe('fetchEngagementData', () => {
    it('returns empty Maps without any DB calls for an empty memberIds array', async () => {
      const result = await fetchEngagementData([]);

      expect(result.ledgerByMember.size).toBe(0);
      expect(result.tasksByMember.size).toBe(0);
      expect(mockSupabaseInstance.getCalls().length).toBe(0);
    });

    it('groups ledger entries and completed tasks by member id in exactly 2 queries', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-01-01' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ assigned_to: 'm1', status: 'completed', completed_at: '2026-01-02' }], error: null });

      const result = await fetchEngagementData(['m1', 'm2']);

      expect(result.ledgerByMember.get('m1')).toHaveLength(1);
      expect(result.tasksByMember.get('m1')).toHaveLength(1);
      expect(result.ledgerByMember.has('m2')).toBe(false);
      const fromCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'from');
      expect(fromCalls).toHaveLength(2);
    });
  });

  describe('computeEngagement', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('classifies as "active" when last activity was within 30 days', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: '2026-07-10T00:00:00Z' }];
      const result = await computeEngagement(members);

      expect(result[0].engagement_level).toBe('active');
    });

    it('classifies as "quiet" when last activity is between 31 and 90 days ago', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: '2026-05-01T00:00:00Z' }];
      const result = await computeEngagement(members);

      expect(result[0].engagement_level).toBe('quiet');
    });

    it('classifies as "inactive" when last activity is over 90 days ago', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: '2025-01-01T00:00:00Z' }];
      const result = await computeEngagement(members);

      expect(result[0].engagement_level).toBe('inactive');
    });

    it('classifies as "inactive" when there is no activity at all (daysSince = Infinity)', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: null }];
      const result = await computeEngagement(members);

      expect(result[0].engagement_level).toBe('inactive');
      expect(result[0].last_activity).toBeNull();
    });

    it('uses the MOST RECENT of last_active_at, confirmed ledger, and completed tasks', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-07-19T00:00:00Z' }], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ assigned_to: 'm1', status: 'completed', completed_at: '2026-07-20T00:00:00Z' }], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: '2026-01-01T00:00:00Z' }];
      const result = await computeEngagement(members);

      expect(result[0].last_activity).toBe('2026-07-20');
    });

    it('counts confirmed and pending contributions separately', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-07-01' },
          { contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-07-02' },
          { contributor_id: 'm1', status: 'pending', confirmed_at: null },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [{ id: 'm1', display_name: 'Bob', last_active_at: null }];
      const result = await computeEngagement(members);

      expect(result[0].confirmed_contributions_count).toBe(2);
      expect(result[0].pending_contributions_count).toBe(1);
    });

    it('handles multiple members independently', async () => {
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const members = [
        { id: 'm1', display_name: 'Bob', last_active_at: '2026-07-20T00:00:00Z' },
        { id: 'm2', display_name: 'Alice', last_active_at: '2020-01-01T00:00:00Z' },
      ];
      const result = await computeEngagement(members);

      expect(result[0].engagement_level).toBe('active');
      expect(result[1].engagement_level).toBe('inactive');
    });
  });
});
