// Exercise the real domain services below the new handlers. Supabase responses
// are scripted; query assertions do not replace multi-workspace DB integration.
jest.mock('../../../src/config/supabase', () => {
  const instance = require('../../mocks/supabase.mock').mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});
jest.mock('../../../src/services/notification.service', () => ({ send: jest.fn() }));
jest.mock('../../../src/services/audit.service', () => ({ log: jest.fn() }));
jest.mock('../../../src/services/storage.service', () => ({}));
jest.mock('../../../src/queues', () => ({ getQueue: jest.fn() }));

const { getContainerSummary, getLedgerSummary } = require('../../../src/agent/services/summary-tools.service');
const db = require('../../../src/config/supabase').__mockInstance;
const CONTAINER_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const context = (role = 'member') => ({
  userId: '11111111-1111-4111-8111-111111111111',
  member: { id: MEMBER_ID, role, isActive: true, workspaceId: WORKSPACE_ID },
  workspace: { id: WORKSPACE_ID },
});
const args = { container_id: CONTAINER_ID };

function queryCalls(table) {
  const calls = db.getCalls();
  const start = calls.findIndex((call) => call.method === 'from' && call.args[0] === table);
  if (start < 0) return [];
  const end = calls.findIndex((call, index) => index > start && call.method === 'from');
  return calls.slice(start, end < 0 ? undefined : end);
}

describe('summary tool service authorization boundary', () => {
  beforeEach(() => db.reset());

  it.each(['member', 'admin'])('preserves participant financial trimming for a %s', async (role) => {
    const participant = (id, name, amount) => ({
      workspace_member_id: id, role: 'contributor', workspace_members: { display_name: name, is_proxy: false },
      contributor_targets: [{ is_current: true, cycle_id: null, target_amount: amount, target_currency: 'NGN' }],
    });
    db.mockResponses(
      { data: { id: CONTAINER_ID, name: 'Rent' }, error: null },
      { data: [participant(MEMBER_ID, 'Ada', '100'), participant('other-member', 'Obi', '500')], error: null },
      { data: [{ contributor_id: MEMBER_ID, status: 'confirmed', base_amount: '20' }, { contributor_id: 'other-member', status: 'confirmed', base_amount: '400' }], error: null },
    );
    const result = await getContainerSummary({ args, context: context(role) });
    expect(result.participants[0].confirmed_paid_base).toBe(20);
    if (role === 'member') {
      expect(result.participants[1]).toEqual({ member_id: 'other-member', display_name: 'Obi', is_proxy: false, role: 'contributor', status: 'partial' });
      expect(result.total_confirmed_base).toBe(20);
      expect(result.total_expected_base).toBe(100);
    } else {
      expect(result.participants[1].confirmed_paid_base).toBe(400);
      expect(result.total_confirmed_base).toBe(420);
      expect(result.total_expected_base).toBe(600);
    }
    expect(queryCalls('containers')).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'eq', args: ['id', CONTAINER_ID] }, { method: 'is', args: ['deleted_at', null] },
    ]));
  });

  it.each(['member', 'admin'])('scopes the ledger query to workspace, container, and the real %s view', async (role) => {
    db.mockResponses(
      { data: { id: CONTAINER_ID, container_type: 'event' }, error: null },
      { data: null, error: null }, // Current caller's participation.
      { data: [{ status: 'confirmed', base_amount: '10' }, { status: 'resolved', base_amount: '15' }], error: null },
    );
    const result = await getLedgerSummary({ args, context: context(role) });
    expect(result.confirmed_count).toBe(2);
    expect(result.confirmed_base_total).toBe(25);
    const filters = queryCalls('ledger_entries');
    expect(filters).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['workspace_id', WORKSPACE_ID] }, { method: 'eq', args: ['container_id', CONTAINER_ID] },
    ]));
    expect(filters.some((call) => call.method === 'eq' && call.args[0] === 'contributor_id')).toBe(role === 'member');
    if (role === 'member') expect(filters).toContainEqual({ method: 'eq', args: ['contributor_id', MEMBER_ID] });
    expect(queryCalls('containers')).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });

  it.each([getContainerSummary, getLedgerSummary])('stops before child reads when the workspace-scoped parent lookup misses', async (handler) => {
    db.mockNextResponse({ data: null, error: null });
    await expect(handler({ args, context: context() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.client.from.mock.calls).toEqual([['containers']]);
    expect(queryCalls('containers')).toContainEqual({ method: 'eq', args: ['workspace_id', WORKSPACE_ID] });
  });
});
