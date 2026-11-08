// Real member/engagement services with scripted Supabase responses. These
// query assertions do not substitute for live database isolation tests.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/membership-cache.service', () => ({ invalidateMembership: jest.fn() }));

const { getMemberEngagement } = require('../../../src/agent/services/summary-tools.service');
const db = require('../../../src/config/supabase').__mockInstance;
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const context = {
  userId: '11111111-1111-4111-8111-111111111111',
  member: { id: MEMBER_ID, workspaceId: WORKSPACE_ID, isActive: true, role: 'admin' },
  workspace: { id: WORKSPACE_ID },
};

function queryCalls(table) {
  const calls = db.getCalls();
  const start = calls.findIndex((call) => call.method === 'from' && call.args[0] === table);
  const end = calls.findIndex((call, index) => index > start && call.method === 'from');
  return start < 0 ? [] : calls.slice(start, end < 0 ? undefined : end);
}

describe('engagement tool service boundary', () => {
  beforeEach(() => {
    db.reset();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-08T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('uses existing classifications/counts and keeps all three queries in the authenticated workspace', async () => {
    db.mockResponses(
      { data: [
        { id: MEMBER_ID, display_name: 'Adaeze', last_active_at: '2026-11-01T00:00:00Z' },
        { id: OTHER_MEMBER_ID, display_name: 'Obi', last_active_at: '2026-01-01T00:00:00Z', is_active: false },
      ], error: null },
      { data: [
        { contributor_id: MEMBER_ID, status: 'confirmed', confirmed_at: '2026-11-02T00:00:00Z' },
        { contributor_id: MEMBER_ID, status: 'resolved', confirmed_at: '2026-11-03T00:00:00Z' },
        { contributor_id: MEMBER_ID, status: 'pending', confirmed_at: null },
        { contributor_id: MEMBER_ID, status: 'proof_uploaded', confirmed_at: null },
      ], error: null },
      { data: [{ assigned_to: MEMBER_ID, status: 'completed', completed_at: '2026-11-07T00:00:00Z' }], error: null },
    );

    await expect(getMemberEngagement({ context })).resolves.toEqual([
      { member_id: MEMBER_ID, display_name: 'Adaeze', last_activity: '2026-11-07', confirmed_contributions_count: 2, pending_contributions_count: 1, engagement_level: 'active' },
      { member_id: OTHER_MEMBER_ID, display_name: 'Obi', last_activity: '2026-01-01', confirmed_contributions_count: 0, pending_contributions_count: 0, engagement_level: 'inactive' },
    ]);
    expect(queryCalls('workspace_members')).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
      { method: 'eq', args: ['is_proxy', false] },
      { method: 'is', args: ['deleted_at', null] },
    ]));
    expect(queryCalls('workspace_members').some((call) => call.method === 'eq' && call.args[0] === 'is_active')).toBe(false);
    expect(queryCalls('ledger_entries')).toEqual(expect.arrayContaining([
      { method: 'in', args: ['contributor_id', [MEMBER_ID, OTHER_MEMBER_ID]] },
      { method: 'eq', args: ['workspace_id', WORKSPACE_ID] },
    ]));
    expect(queryCalls('container_tasks')).toEqual(expect.arrayContaining([
      { method: 'select', args: [expect.stringContaining('containers!container_tasks_container_id_fkey!inner(workspace_id)')] },
      { method: 'in', args: ['assigned_to', [MEMBER_ID, OTHER_MEMBER_ID]] },
      { method: 'eq', args: ['status', 'completed'] },
      { method: 'eq', args: ['containers.workspace_id', WORKSPACE_ID] },
    ]));
  });

  it('returns an empty result without activity reads when no members are eligible', async () => {
    db.mockNextResponse({ data: [], error: null });
    await expect(getMemberEngagement({ context })).resolves.toEqual([]);
    expect(db.client.from.mock.calls).toEqual([['workspace_members']]);
  });

  it.each(['members', 'ledger', 'tasks'])('rejects %s query errors rather than returning a partial result', async (source) => {
    const failed = { data: null, error: { message: 'PRIVATE_DATABASE_DETAIL' } };
    db.mockResponses(
      source === 'members' ? failed : { data: [{ id: MEMBER_ID, display_name: 'Adaeze', last_active_at: null }], error: null },
      source === 'ledger' ? failed : { data: [], error: null },
      source === 'tasks' ? failed : { data: [], error: null },
    );
    await expect(getMemberEngagement({ context })).rejects.toMatchObject({
      code: 'ENGAGEMENT_UNAVAILABLE', statusCode: 503,
      message: 'Member engagement is unavailable. Please try again.',
    });
  });

  it('denies a non-admin before any real service query', async () => {
    await expect(getMemberEngagement({ context: { ...context, member: { ...context.member, role: 'member' } } }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.client.from).not.toHaveBeenCalled();
  });
});
