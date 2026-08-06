// tests/unit/services/engagement_check.service.test.js
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
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { runEngagementCheck } = require('../../../src/services/engagement_check.service');
const logger = require('../../../src/utils/logger');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

describe('services/engagement_check.service — runEngagementCheck', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
  });

  it('zero active non-proxy members -> completes with processed:0', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runEngagementCheck();

    expect(logger.info).toHaveBeenCalledWith('Engagement check complete', { processed: 0 });
  });

  it('excludes proxy members via the query filter', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runEngagementCheck();

    const proxyEqCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'eq' && c.args[0] === 'is_proxy');
    expect(proxyEqCall.args[1]).toBe(false);
  });

  it('a member with no candidate activity dates at all is skipped (no update issued)', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', workspace_id: 'ws-1', last_active_at: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await runEngagementCheck();

    const updateCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'update');
    expect(updateCalls.length).toBe(0);
  });

  it('REGRESSION: relies on a DB-level .or() guard so a stale-but-older computed value never overwrites a newer stored one', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', workspace_id: 'ws-1', last_active_at: '2026-07-20T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-07-01T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runEngagementCheck();

    const orCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'or');
    expect(orCall.args[0]).toBe('last_active_at.is.null,last_active_at.lt.2026-07-20T00:00:00.000Z');
  });

  it('computes the latest timestamp across last_active_at, confirmed ledger, and completed tasks', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', workspace_id: 'ws-1', last_active_at: '2026-01-01T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ contributor_id: 'm1', status: 'confirmed', confirmed_at: '2026-06-01T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ assigned_to: 'm1', status: 'completed', completed_at: '2026-07-15T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runEngagementCheck();

    const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
    expect(updateCall.args[0].last_active_at).toBe('2026-07-15T00:00:00.000Z');
  });

  it('excludes non-confirmed ledger entries from the latest-activity computation', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', workspace_id: 'ws-1', last_active_at: '2026-01-01T00:00:00.000Z' }], error: null });
    mockSupabaseInstance.mockNextResponse({
      data: [{ contributor_id: 'm1', status: 'pending', confirmed_at: '2026-07-25T00:00:00.000Z' }],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runEngagementCheck();

    const updateCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'update');
    expect(updateCall.args[0].last_active_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('logs processed count matching total members scanned', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: [
        { id: 'm1', workspace_id: 'ws-1', last_active_at: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', workspace_id: 'ws-1', last_active_at: null },
      ],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await runEngagementCheck();

    expect(logger.info).toHaveBeenCalledWith('Engagement check complete', { processed: 2 });
  });
});
