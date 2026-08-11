// tests/unit/services/dashboard.service.test.js
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
jest.mock('../../../src/services/dashboard-cache.service');

const dashboardService = require('../../../src/services/dashboard.service');
const dashboardCache = require('../../../src/services/dashboard-cache.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';

/**
 * Queues the 7 responses buildSharedDashboardPayload's fan-out consumes.
 *
 * IMPORTANT: consumption order follows Promise.all's ARRAY order (the
 * order in which .then() is invoked on each element), which is NOT the
 * same as the order .from() calls are recorded in getCalls() (query
 * *construction* happens earlier, synchronously, for
 * pendingConfirmationsQuery specifically, since it's built before the
 * Promise.all array literal). Empirically verified consumption order:
 *   0. unread count (separate Promise.all in getDashboardData itself)
 *   1. workspace_members
 *   2. containers (active events)
 *   3. containers (recurring pools)
 *   4. contributor_targets
 *   5. audit_log (recent activity)
 *   6. ledger_entries (pending confirmations) — LAST, since it's the
 *      final element of the Promise.all array even though its query
 *      chain was constructed first in the source.
 * When targetsData is non-empty, two more queries follow afterward:
 * container_participants, then containers (for names).
 */
function queueDashboardResponses({
  unreadCount = { count: 0, error: null },
  members = { data: [], error: null },
  events = { data: [], error: null },
  pools = { data: [], error: null },
  targets = { data: [], error: null },
  activity = { data: [], error: null },
  pending = { data: [], error: null },
  disputes = { count: 0, error: null },
  milestones = { data: [], error: null },
  participants = null,
  containerNames = null,
} = {}) {
  // ── Query 1-8: Promise.all ──
  mockSupabaseInstance.mockNextResponse(unreadCount);   // 1: notifications
  mockSupabaseInstance.mockNextResponse(members);       // 2: workspace_members
  mockSupabaseInstance.mockNextResponse(events);        // 3: containers (events)
  mockSupabaseInstance.mockNextResponse(pools);         // 4: containers (recurring)
  mockSupabaseInstance.mockNextResponse(targets);       // 5: contributor_targets
  mockSupabaseInstance.mockNextResponse(activity);      // 6: audit_log
  mockSupabaseInstance.mockNextResponse(pending);       // 7: ledger_entries
  mockSupabaseInstance.mockNextResponse(disputes);      // 8: disputes
  mockSupabaseInstance.mockNextResponse(milestones);    // 9: milestones (in Promise.all, but I missed this!)

  // ── Query 10: container_participants ──
  if (participants) {
    mockSupabaseInstance.mockNextResponse(participants);
  } else {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
  }

  // ── Query 11: containers ──
  if (containerNames) {
    mockSupabaseInstance.mockNextResponse(containerNames);
  } else {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
  }
}

describe('services/dashboard.service', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    dashboardCache.getCachedDashboard.mockResolvedValue(null);
    dashboardCache.setCachedDashboard.mockResolvedValue();
    dashboardCache.getCachedOverdueSummary.mockResolvedValue(null);
    dashboardCache.setCachedOverdueSummary.mockResolvedValue();
  });

  describe('getDashboardData', () => {
    it('cache hit: uses the cached shared payload, still fetches unread count fresh', async () => {
      dashboardCache.getCachedDashboard.mockResolvedValueOnce({
        workspace_summary: { member_count: 5 }, active_events: [], recurring_pools: [],
        upcoming_deadlines: [], pending_confirmations: [], recent_activity: [],
      });
      mockSupabaseInstance.mockNextResponse({ count: 3, error: null });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.unread_notification_count).toBe(3);
      expect(result.workspace_summary.member_count).toBe(5);
      expect(dashboardCache.setCachedDashboard).not.toHaveBeenCalled();
    });

    it('cache miss: builds the payload fresh and writes it back to cache', async () => {
      queueDashboardResponses();

      await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(dashboardCache.setCachedDashboard).toHaveBeenCalledWith(WORKSPACE_ID, true, expect.any(Object));
    });

    it('non-admin caller: pending_confirmations is always [] regardless of DB content', async () => {
      queueDashboardResponses();

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: false, memberId: 'm1' });

      expect(result.pending_confirmations).toEqual([]);
    });

    it('admin caller: pending_confirmations includes joined names', async () => {
      queueDashboardResponses({
        pending: {
          data: [{ id: 'e1', original_amount: 50, contributor: { display_name: 'Bob' }, recorded_by_member: { display_name: 'Admin' } }],
          error: null,
        },
      });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.pending_confirmations[0].contributor_name).toBe('Bob');
      expect(result.pending_confirmations[0].recorded_by_name).toBe('Admin');
    });

    it('upcoming_deadlines resolves member and container names from the follow-up queries', async () => {
  // ── Mock ALL 11 queries ──
  queueDashboardResponses({
    // Query 5: contributor_targets
    targets: { 
      data: [{ 
        target_amount: 50, 
        target_currency: 'USD', 
        due_date: '2026-08-12', 
        container_participant_id: 'p1', 
        container_id: 'c1' 
      }], 
      error: null 
    },
    // Query 10: container_participants
    participants: { 
      data: [{ 
        id: 'p1', 
        workspace_member_id: 'm1', 
        workspace_members: { display_name: 'Bob' } 
      }], 
      error: null 
    },
    // Query 11: containers
    containerNames: { 
      data: [{ id: 'c1', name: 'Rent' }], 
      error: null 
    },
  });

  const result = await dashboardService.getDashboardData({ 
    workspaceId: WORKSPACE_ID, 
    isAdmin: true, 
    memberId: 'm1' 
  });

  expect(result.upcoming_deadlines[0]).toEqual(expect.objectContaining({
    member_name: 'Bob', 
    container_name: 'Rent', 
    title: '50 USD',
  }));
});

    it('unread_activity_count equals recent_activity.length (documented as-is, not the true unread count)', async () => {
      queueDashboardResponses({
        activity: { data: [{ action: 'x', metadata: null, actor_member: null }, { action: 'y', metadata: null, actor_member: null }], error: null },
      });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.unread_activity_count).toBe(result.recent_activity.length);
      expect(result.unread_activity_count).toBe(2);
    });

    it('activity entries with no actor_member fall back to "System"', async () => {
      queueDashboardResponses({
        activity: { data: [{ action: 'workspace.deleted', metadata: null, actor_member: null }], error: null },
      });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.recent_activity[0].actor_name).toBe('System');
    });

    it('active_events computes total_confirmed_base only from confirmed ledger entries', async () => {
      queueDashboardResponses({
        events: {
          data: [{
            id: 'c1', name: 'Party', budget_target: 100,
            container_participants: [{ id: 'p1' }],
            ledger_entries: [{ base_amount: 50, status: 'confirmed' }, { base_amount: 999, status: 'pending' }],
          }],
          error: null,
        },
      });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.active_events[0].total_confirmed_base).toBe(50);
      expect(result.active_events[0].progress_pct).toBe(50);
    });

    it('recurring_pools picks the first open/upcoming cycle as current_cycle', async () => {
      queueDashboardResponses({
        pools: {
          data: [{
            id: 'p1', name: 'Rent Pool',
            container_cycles: [{ id: 'cy1', status: 'closed' }, { id: 'cy2', status: 'open' }],
          }],
          error: null,
        },
      });

      const result = await dashboardService.getDashboardData({ workspaceId: WORKSPACE_ID, isAdmin: true, memberId: 'm1' });

      expect(result.recurring_pools[0].current_cycle.id).toBe('cy2');
    });
  });

  describe('getOverdueSummaryData', () => {
    it('cache hit returns cached payload directly, no DB queries', async () => {
      dashboardCache.getCachedOverdueSummary.mockResolvedValueOnce({ overdue_count: 5, overdue: [] });

      const result = await dashboardService.getOverdueSummaryData({ workspaceId: WORKSPACE_ID });

      expect(result).toEqual({ overdue_count: 5, overdue: [] });
      expect(mockSupabaseInstance.getCalls().length).toBe(0);
    });

    it('a target due exactly today is NOT counted as overdue (strict less-than)', async () => {
      const today = new Date().toISOString().split('T')[0];
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', container_id: 'c1', containers: { name: 'Rent' }, contributor_targets: [{ target_amount: 100, due_date: today, is_current: true, cycle_id: null }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });

      const result = await dashboardService.getOverdueSummaryData({ workspaceId: WORKSPACE_ID });

      expect(result.overdue_count).toBe(0);
    });

    it('a genuinely overdue, unpaid target IS counted', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', container_id: 'c1', containers: { name: 'Rent' }, contributor_targets: [{ target_amount: 100, due_date: '2020-01-01', is_current: true, cycle_id: null }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', display_name: 'Bob' }], error: null });

      const result = await dashboardService.getOverdueSummaryData({ workspaceId: WORKSPACE_ID });

      expect(result.overdue_count).toBe(1);
      expect(result.overdue[0].display_name).toBe('Bob');
    });

    it('multiple overdue containers for the same member are aggregated into one entry', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [
          { workspace_member_id: 'm1', container_id: 'c1', containers: { name: 'Rent' }, contributor_targets: [{ target_amount: 100, due_date: '2020-01-01', is_current: true, cycle_id: null }] },
          { workspace_member_id: 'm1', container_id: 'c2', containers: { name: 'Utilities' }, contributor_targets: [{ target_amount: 50, due_date: '2020-01-01', is_current: true, cycle_id: null }] },
        ],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [], error: null });
      mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', display_name: 'Bob' }], error: null });

      const result = await dashboardService.getOverdueSummaryData({ workspaceId: WORKSPACE_ID });

      expect(result.overdue_count).toBe(1);
      expect(result.overdue[0].total_outstanding).toBe(150);
      expect(result.overdue[0].containers).toHaveLength(2);
    });

    it('a fully-paid target is not counted as overdue even if due_date has passed', async () => {
      mockSupabaseInstance.mockNextResponse({
        data: [{ workspace_member_id: 'm1', container_id: 'c1', containers: { name: 'Rent' }, contributor_targets: [{ target_amount: 100, due_date: '2020-01-01', is_current: true, cycle_id: null }] }],
        error: null,
      });
      mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', container_id: 'c1', base_amount: 100 }], error: null });

      const result = await dashboardService.getOverdueSummaryData({ workspaceId: WORKSPACE_ID });

      expect(result.overdue_count).toBe(0);
    });
  });
});
