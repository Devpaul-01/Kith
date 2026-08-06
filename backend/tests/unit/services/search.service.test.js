// tests/unit/services/search.service.test.js
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

const { searchWorkspace } = require('../../../src/services/search.service');
const mockSupabaseInstance = require('../../../src/config/supabase').__mockInstance;

const WORKSPACE_ID = 'ws-1';

describe('services/search.service — searchWorkspace', () => {
  beforeEach(() => {
    mockSupabaseInstance.reset();
  });

  it('empty query -> returns { results: [], query } WITHOUT hitting the DB', async () => {
    const result = await searchWorkspace({ workspaceId: WORKSPACE_ID, query: '' });

    expect(result).toEqual({ results: [], query: '' });
    expect(mockSupabaseInstance.getCalls().length).toBe(0);
  });

  it('1-character query -> returns empty results without hitting the DB (below the 2-char minimum)', async () => {
    const result = await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'a' });

    expect(result.results).toEqual([]);
    expect(mockSupabaseInstance.getCalls().length).toBe(0);
  });

  it('whitespace-only query is trimmed and treated as empty', async () => {
    const result = await searchWorkspace({ workspaceId: WORKSPACE_ID, query: '   ' });

    expect(result).toEqual({ results: [], query: '' });
  });

  it('2-character query (boundary) DOES hit the DB', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'bo' });

    expect(mockSupabaseInstance.getCalls().length).toBeGreaterThan(0);
  });

  it('escapes ILIKE special characters in the query before searching', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await searchWorkspace({ workspaceId: WORKSPACE_ID, query: '50%_x' });

    const ilikeCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'ilike');
    ilikeCalls.forEach((c) => expect(c.args[1]).toBe('%50\\%\\_x%'));
  });

  it('combines member and container results, correctly typed', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'm1', display_name: 'Bob', role: 'member', is_proxy: false }], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [{ id: 'c1', name: 'Bob\'s Party', container_type: 'event', status: 'active' }], error: null });

    const result = await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'bob' });

    expect(result.results).toEqual([
      { type: 'member', id: 'm1', display_name: 'Bob', role: 'member', is_proxy: false },
      { type: 'container', id: 'c1', name: "Bob's Party", container_type: 'event', status: 'active' },
    ]);
  });

  it('clamps limit to a maximum of 20', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'bob', limit: 500 });

    const limitCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'limit');
    limitCalls.forEach((c) => expect(c.args[0]).toBe(20));
  });

  it('defaults limit to 10 when omitted', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'bob' });

    const limitCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'limit');
    limitCalls.forEach((c) => expect(c.args[0]).toBe(10));
  });

  it('non-numeric limit falls back to the default of 10', async () => {
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });
    mockSupabaseInstance.mockNextResponse({ data: [], error: null });

    await searchWorkspace({ workspaceId: WORKSPACE_ID, query: 'bob', limit: 'abc' });

    const limitCalls = mockSupabaseInstance.getCalls().filter((c) => c.method === 'limit');
    limitCalls.forEach((c) => expect(c.args[0]).toBe(10));
  });
});
