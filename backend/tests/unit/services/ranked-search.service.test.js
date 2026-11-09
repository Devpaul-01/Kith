jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase } = require('../../mocks/supabase.mock');
  const instance = mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});

const { findMembers, findContainers, findTasks, findLedgerEntries, findDisputes, findGroups } = require('../../../src/services/search.service');
const db = require('../../../src/config/supabase').__mockInstance;
const { ValidationError } = require('../../../src/utils/errors');

const workspaceId = '11111111-1111-4111-8111-111111111111';
const member = {
  id: '22222222-2222-4222-8222-222222222222', display_name: 'Adaeze Okafor',
  role: 'member', is_proxy: true, match_type: 'fuzzy', score: 0.5,
};
const container = {
  id: '33333333-3333-4333-8333-333333333333', name: 'Rent',
  container_type: 'recurring', status: 'active', match_type: 'exact', score: 1,
};
const callerId = member.id;
const task = {
  id: '44444444-4444-4444-8444-444444444444', container_id: container.id, title: 'Shopping',
  assigned_to: callerId, status: 'pending', due_date: '2026-11-20', match_type: 'substring', score: 0.75,
};
const entry = {
  id: '55555555-5555-4555-8555-555555555555', container_id: container.id, contributor_id: callerId,
  contributor_name: member.display_name, note: 'Rent', original_amount: '9999999999999.99',
  original_currency: 'NGN', entry_type: 'contribution', status: 'pending',
  recorded_at: '2026-11-09T00:00:00.123456Z', match_type: 'exact', score: 0,
};
const dispute = {
  id: '66666666-6666-4666-8666-666666666666', ledger_entry_id: entry.id, raised_by: callerId,
  raised_by_name: member.display_name, reason: 'Amount is incorrect', status: 'open',
  raised_at: '2026-11-09T01:00:00Z', match_type: 'fuzzy', score: 0.45,
};
const group = {
  id: '77777777-7777-4777-8777-777777777777', name: 'Cousins', description: null,
  created_at: '2026-11-01T00:00:00Z', match_type: 'exact', score: 1,
};
const callerScope = { callerId, isAdmin: false };
const callerRpcScope = { p_caller_id: callerId, p_is_admin: false };
const containerRpcScope = { ...callerRpcScope, p_container_id: null };

describe.each([
  ['members', findMembers, 'search_members_ranked', member, {}, {}],
  ['containers', findContainers, 'search_containers_ranked', container, {}, {}],
  ['tasks', findTasks, 'search_tasks_ranked', task, callerScope, containerRpcScope],
  ['ledger entries', findLedgerEntries, 'search_ledger_entries_ranked', entry, callerScope, containerRpcScope],
  ['disputes', findDisputes, 'search_disputes_ranked', dispute, callerScope, callerRpcScope],
  ['groups', findGroups, 'search_groups_ranked', group, {}, {}],
])('ranked %s search', (label, find, rpcName, candidate, scope, rpcScope) => {
  beforeEach(() => db.reset());
  const search = (params) => find({ workspaceId, ...scope, ...params });

  it('scopes the RPC, trims the query, escapes wildcards, and requests a lookahead row', async () => {
    db.mockNextRpcResponse({ data: [], error: null });
    const result = await search({ query: '  50%_x\\  ' });

    expect(db.getRpcCalls()).toEqual([{
      fnName: rpcName,
      params: { p_workspace_id: workspaceId, p_query: '50%_x\\', p_pattern: '%50\\%\\_x\\\\%', p_limit: 11, ...rpcScope },
    }]);
    expect(result).toEqual({ query: '50%_x\\', status: 'not_found', candidates: [], has_more: false });
  });

  it('returns a single candidate with only allowed fields and its original score', async () => {
    db.mockNextRpcResponse({ data: [{ ...candidate, admin_notes: 'secret', public_token: 'secret',
      proofs: ['private-file'], notes: ['private-note'], base_amount: 42, user_id: 'account-id',
      members: ['private-membership-list'], workspace_id: workspaceId, recorded_by: callerId,
    }], error: null });
    const result = await search({ query: 'Adaze' });

    expect(result).toEqual({ query: 'Adaze', status: 'single_match', candidates: [candidate], has_more: false });
    expect(result).not.toHaveProperty('resolved_id');
  });

  it('preserves database ranking and marks multiple candidates ambiguous even with an exact first result', async () => {
    const first = { ...candidate, match_type: 'exact', score: 1 };
    const second = { ...candidate, id: '44444444-4444-4444-8444-444444444444', match_type: 'fuzzy', score: 0.4 };
    db.mockNextRpcResponse({ data: [first, second], error: null });

    await expect(search({ query: 'Adaeze', limit: 2 })).resolves.toEqual({
      query: 'Adaeze', status: 'ambiguous', candidates: [first, second], has_more: false,
    });
  });

  it('truncates the display list without hiding additional candidates', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ ...candidate, id: `candidate-${index}` }));
    db.mockNextRpcResponse({ data: rows, error: null });
    const result = await search({ query: 'Adaeze', limit: 2 });

    expect(result).toEqual({ query: 'Adaeze', status: 'ambiguous', candidates: rows.slice(0, 2), has_more: true });
    expect(db.getRpcCalls()[0].params.p_limit).toBe(3);
  });

  it.each([
    { query: '' }, { query: '   ' }, { query: 'a' }, { query: null }, { query: 123 },
    { query: 'a'.repeat(201) }, { limit: 1 }, { limit: 21 }, { limit: 2.5 }, { limit: '10' },
    { workspaceId: 'invalid' }, { workspaceId: undefined },
    { workspace_id: workspaceId }, { role: 'admin' }, { approved: true },
    { p_is_admin: true }, { p_pattern: '%' }, { container_id: container.id },
  ])('rejects invalid parameters before reaching the database: %j', async (override) => {
    await expect(search({ query: 'Adaeze', ...override })).rejects.toBeInstanceOf(ValidationError);
    expect(db.getRpcCalls()).toEqual([]);
  });

  it.each([
    { data: null, error: { code: 'PGRST202', message: 'RPC missing with internal details' } },
    { data: null, error: null },
    { data: {}, error: null },
    { data: [null], error: null }, { data: ['candidate'], error: null },
    { data: [42], error: null }, { data: [[]], error: null },
    { data: [candidate, null], error: null },
  ])('reports an unavailable search instead of a false no-match on RPC failure', async (response) => {
    db.mockNextRpcResponse(response);
    await expect(search({ query: 'Adaeze' })).rejects.toMatchObject({
      statusCode: 503, code: 'SEARCH_UNAVAILABLE', message: 'Entity search is unavailable. Please try again.',
    });
  });

  it('converts transport failures into the same typed availability error', async () => {
    db.client.rpc.mockRejectedValueOnce(new Error('Network detail'));
    await expect(search({ query: 'Adaeze' })).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });
});

describe.each([
  ['tasks', findTasks], ['ledger entries', findLedgerEntries], ['disputes', findDisputes],
])('private %s search scope', (label, find) => {
  beforeEach(() => db.reset());

  it.each([true, false])('passes the server caller and admin flag %s without inferring broader access', async (isAdmin) => {
    db.mockNextRpcResponse({ data: [], error: null });
    await find({ workspaceId, callerId, isAdmin, query: 'Rent' });
    expect(db.getRpcCalls()[0].params).toMatchObject({ p_workspace_id: workspaceId, p_caller_id: callerId, p_is_admin: isAdmin });
  });

  it.each([
    { callerId: undefined }, { callerId: 'Adaeze' }, { callerId: null },
    { isAdmin: undefined }, { isAdmin: 'true' }, { isAdmin: 1 }, { isAdmin: null },
  ])('requires valid server identity and an explicit boolean role: %j', async (override) => {
    await expect(find({ workspaceId, callerId, isAdmin: false, query: 'Rent', ...override })).rejects.toBeInstanceOf(ValidationError);
    expect(db.getRpcCalls()).toEqual([]);
  });
});

describe.each([['tasks', findTasks], ['ledger entries', findLedgerEntries]])('%s container filter', (label, find) => {
  beforeEach(() => db.reset());

  it('forwards a resolved container ID without replacing caller or workspace scope', async () => {
    db.mockNextRpcResponse({ data: [], error: null });
    await find({ workspaceId, callerId, isAdmin: false, query: 'Rent', containerId: container.id, limit: 20 });
    expect(db.getRpcCalls()[0].params).toMatchObject({
      p_workspace_id: workspaceId, p_caller_id: callerId, p_is_admin: false, p_container_id: container.id, p_limit: 21,
    });
  });

  it.each([null, 'Rent', [container.id]])('rejects invalid container scope: %j', async (containerId) => {
    await expect(find({ workspaceId, callerId, isAdmin: false, query: 'Rent', containerId })).rejects.toBeInstanceOf(ValidationError);
    expect(db.getRpcCalls()).toEqual([]);
  });
});

it('preserves exact signed decimal text and currency without parsing or combining ledger candidates', async () => {
  db.reset();
  const rows = [entry, { ...entry, id: task.id, original_currency: 'USD' },
    { ...entry, id: dispute.id, original_amount: '-0.01', entry_type: 'correction' }];
  db.mockNextRpcResponse({ data: rows, error: null });
  const result = await findLedgerEntries({ workspaceId, callerId, isAdmin: false, query: '9999999999999.99' });
  expect(result).toEqual({ query: '9999999999999.99', status: 'ambiguous', candidates: rows, has_more: false });
  expect(db.getRpcCalls()[0].params.p_query).toBe('9999999999999.99');
});
