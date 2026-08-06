// tests/unit/services/cycle_generation.service.test.js
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

const { generateCycles } = require('../../../src/services/cycle_generation.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const CONTAINER_ID = 'container-1';

describe('services/cycle_generation.service — generateCycles', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-15T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('container not found -> early return, no further queries', async () => {
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await generateCycles({ container_id: CONTAINER_ID });

    expect(mockSupabaseInstance.getCalls().filter((c) => c.method === 'from').length).toBe(1);
  });

  it('first-ever generation starts from recurrence_start with cycle_number 1', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 3 });

    const upsertCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert' && c.args[0]?.container_id === CONTAINER_ID);
    expect(upsertCalls[0].args[0].cycle_number).toBe(1);
    expect(upsertCalls[0].args[0].cycle_start).toBe('2026-01-01');
  });

  it('subsequent generation starts the day after lastCycle.cycle_end, with incremented cycle_number', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-02-28', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: { cycle_number: 1, cycle_end: '2026-01-31' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-2' }, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 3 });

    const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert' && c.args[0]?.container_id === CONTAINER_ID);
    expect(upsertCall.args[0].cycle_number).toBe(2);
    expect(upsertCall.args[0].cycle_start).toBe('2026-02-01');
  });

  it('recurrence_end earlier than the default cutoff stops generation there', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 12 });

    const upsertCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert' && c.args[0]?.container_id === CONTAINER_ID);
    expect(upsertCalls).toHaveLength(1);
  });

  it('monthly cadence starting on the 31st resolves to a valid calendar cycle_end (month-length rollover)', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-31', recurrence_end: '2026-02-28', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 1 });

    const upsertCall = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert' && c.args[0]?.container_id === CONTAINER_ID);
    expect(upsertCall.args[0].cycle_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(upsertCall.args[0].cycle_end).toString()).not.toBe('Invalid Date');
  });

  it('pause_pool override marks the cycle "skipped" and creates NO contributor_targets for it', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ override_type: 'pause_pool', cycle_start: '2026-01-01', member_id: null, new_target: null, new_currency: null }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', is_current: true, cycle_id: null }] }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 1 });

    const cycleUpsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert' && c.args[0]?.container_id === CONTAINER_ID);
    expect(cycleUpsert.args[0].status).toBe('skipped');

    const targetUpserts = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert' && c.args[0]?.workspace_member_id);
    expect(targetUpserts).toHaveLength(0);
  });

  it('skip_member override excludes only that participant from target creation', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ override_type: 'skip_member', cycle_start: '2026-01-01', member_id: 'm1', new_target: null, new_currency: null }], error: null });
    mockSupabaseInstance.mockNextResponse({
      data: [
        { id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', is_current: true, cycle_id: null }] },
        { id: 'p2', workspace_member_id: 'm2', contributor_targets: [{ target_amount: 50, target_currency: 'USD', is_current: true, cycle_id: null }] },
      ],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 1 });

    const targetUpserts = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert' && c.args[0]?.workspace_member_id);
    expect(targetUpserts).toHaveLength(1);
    expect(targetUpserts[0].args[0].workspace_member_id).toBe('m2');
  });

  it('adjust_target override uses the overridden amount/currency instead of the base target', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ override_type: 'adjust_target', cycle_start: '2026-01-01', member_id: 'm1', new_target: 200, new_currency: 'EUR' }], error: null });
    mockSupabaseInstance.mockNextResponse({
      data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [{ target_amount: 100, target_currency: 'USD', is_current: true, cycle_id: null }] }],
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: { id: 'cycle-1' }, error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 1 });

    const targetUpsert = mockSupabaseInstance.getCalls().find((c) => c.method === 'upsert' && c.args[0]?.workspace_member_id === 'm1');
    expect(targetUpsert.args[0].target_amount).toBe(200);
    expect(targetUpsert.args[0].target_currency).toBe('EUR');
  });

  it('idempotent re-run: a duplicate cycle upsert resolves to no row, so no targets are created for it', async () => {
    mockSupabaseInstance.mockNextResponse({
      data: { id: CONTAINER_ID, recurrence_cadence: 'monthly', recurrence_start: '2026-01-01', recurrence_end: '2026-01-31', created_by: 'admin-1' },
      error: null,
    });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'p1', workspace_member_id: 'm1', contributor_targets: [] }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: null, error: null });

    await generateCycles({ container_id: CONTAINER_ID, generate_months_ahead: 1 });

    const targetUpserts = mockSupabaseInstance.getCalls().filter((c) => c.method === 'upsert' && c.args[0]?.workspace_member_id);
    expect(targetUpserts).toHaveLength(0);
  });
});
