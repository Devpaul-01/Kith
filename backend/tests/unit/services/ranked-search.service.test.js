jest.mock('../../../src/config/supabase', () => {
  const { mockSupabase } = require('../../mocks/supabase.mock');
  const instance = mockSupabase();
  return { supabaseAdmin: instance.client, __mockInstance: instance };
});

const { findMembers, findContainers } = require('../../../src/services/search.service');
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

describe.each([
  ['members', findMembers, 'search_members_ranked', member],
  ['containers', findContainers, 'search_containers_ranked', container],
])('ranked %s search', (label, find, rpcName, candidate) => {
  beforeEach(() => db.reset());

  it('scopes the RPC, trims the query, escapes wildcards, and requests a lookahead row', async () => {
    db.mockNextRpcResponse({ data: [], error: null });
    const result = await find({ workspaceId, query: '  50%_x\\  ' });

    expect(db.getRpcCalls()).toEqual([{
      fnName: rpcName,
      params: { p_workspace_id: workspaceId, p_query: '50%_x\\', p_pattern: '%50\\%\\_x\\\\%', p_limit: 11 },
    }]);
    expect(result).toEqual({ query: '50%_x\\', status: 'not_found', candidates: [], has_more: false });
  });

  it('returns a single candidate with only allowed fields and its original score', async () => {
    db.mockNextRpcResponse({ data: [{ ...candidate, admin_notes: 'secret', public_token: 'secret' }], error: null });
    const result = await find({ workspaceId, query: 'Adaze' });

    expect(result).toEqual({ query: 'Adaze', status: 'single_match', candidates: [candidate], has_more: false });
    expect(result).not.toHaveProperty('resolved_id');
  });

  it('preserves database ranking and marks multiple candidates ambiguous even with an exact first result', async () => {
    const first = { ...candidate, match_type: 'exact', score: 1 };
    const second = { ...candidate, id: '44444444-4444-4444-8444-444444444444', match_type: 'fuzzy', score: 0.4 };
    db.mockNextRpcResponse({ data: [first, second], error: null });

    await expect(find({ workspaceId, query: 'Adaeze', limit: 2 })).resolves.toEqual({
      query: 'Adaeze', status: 'ambiguous', candidates: [first, second], has_more: false,
    });
  });

  it('truncates the display list without hiding additional candidates', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ ...candidate, id: `candidate-${index}` }));
    db.mockNextRpcResponse({ data: rows, error: null });
    const result = await find({ workspaceId, query: 'Adaeze', limit: 2 });

    expect(result).toEqual({ query: 'Adaeze', status: 'ambiguous', candidates: rows.slice(0, 2), has_more: true });
    expect(db.getRpcCalls()[0].params.p_limit).toBe(3);
  });

  it.each([
    { query: '' }, { query: '   ' }, { query: 'a' }, { query: null }, { query: 123 },
    { query: 'a'.repeat(201) }, { limit: 1 }, { limit: 21 }, { limit: 2.5 }, { limit: '10' },
    { workspaceId: 'invalid' }, { workspaceId: undefined },
  ])('rejects invalid parameters before reaching the database: %j', async (override) => {
    await expect(find({ workspaceId, query: 'Adaeze', ...override })).rejects.toBeInstanceOf(ValidationError);
    expect(db.getRpcCalls()).toEqual([]);
  });

  it.each([
    { data: null, error: { code: 'PGRST202', message: 'RPC missing with internal details' } },
    { data: null, error: null },
    { data: {}, error: null },
  ])('reports an unavailable search instead of a false no-match on RPC failure', async (response) => {
    db.mockNextRpcResponse(response);
    await expect(find({ workspaceId, query: 'Adaeze' })).rejects.toMatchObject({
      statusCode: 503, code: 'SEARCH_UNAVAILABLE', message: 'Entity search is unavailable. Please try again.',
    });
  });

  it('converts transport failures into the same typed availability error', async () => {
    db.client.rpc.mockRejectedValueOnce(new Error('Network detail'));
    await expect(find({ workspaceId, query: 'Adaeze' })).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });
});
