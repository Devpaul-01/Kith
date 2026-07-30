// tests/mocks/supabase.mock.js
//
// The single most important shared test utility in this project (see
// Doc 4 Section 2.5's header note). Given how many service functions
// make 3–6 SEQUENTIAL Supabase calls (list-then-detail, fetch-then-
// update, parallel Promise.all fan-outs), every service unit test needs
// to script "call 1 returns X, call 2 returns Y, call 3 errors" without
// hand-rolling that sequencing per test file.
//
// USAGE
// -----
//   const { mockSupabase } = require('../../mocks/supabase.mock');
//
//   jest.mock('../../../src/config/supabase', () => {
//     const { mockSupabase } = require('../../mocks/supabase.mock');
//     const instance = mockSupabase();
//     global.__supabaseMock = instance; // expose for the test file to script
//     return { supabaseAdmin: instance.client, supabase: instance.client, supabaseAuth: instance.client };
//   });
//
//   // in a test:
//   const { mockNextResponse } = global.__supabaseMock;
//   mockNextResponse({ data: { id: 'abc' }, error: null });      // response to call #1
//   mockNextResponse({ data: [{ id: 'x' }], error: null, count: 1 }); // response to call #2
//   const result = await someService.doThing({ ... });
//
// Prefer the exported `createSupabaseMock()` helper below (used by
// tests/mocks/index.js and every service unit test in this package) over
// constructing this by hand — it wires the jest.mock() call for you.
//
// DESIGN NOTES
// ------------
// - Every query-builder method returns `builder` (chainable), matching
//   supabase-js's own fluent API.
// - `.single()` / `.maybeSingle()` and awaiting the builder directly
//   (`await query`, via `.then`) all pull from the SAME sequential
//   `responses` queue, advanced by a single shared `callIndex`. This
//   matches how supabase-js queries actually resolve — a query is a
//   thenable, and `.single()`/`.maybeSingle()` are just the terminal
//   call that makes it await-able with a different unwrap shape — so
//   scripting responses in the order your service code issues queries
//   is the correct mental model regardless of which terminal method it
//   uses.
// - `.rpc()` is tracked SEPARATELY from the main response queue (its own
//   `rpcResponses` queue) since RPC calls don't go through
//   `.from()`/`.select()` chaining at all in supabase-js — they're a
//   distinct top-level method on the client. Script RPC responses with
//   `mockNextRpcResponse()`.
// - `.storage.from(bucket)` is also modeled separately (see
//   `storageBuilder`) since storage.service.js calls
//   `supabase.storage.from(BUCKET).createSignedUploadUrl(...)` /
//   `.download(...)` / `.remove(...)` / `.createSignedUrl(...)`, a
//   completely different chain shape from the Postgres query builder.
// - `.auth` methods used directly on the client (auth.getUser,
//   auth.admin.signOut, auth.admin.updateUserById,
//   auth.admin.getUserById, auth.signInWithPassword, auth.signUp, etc.)
//   are separately mockable jest.fn()s on `client.auth` / `client.auth.admin`
//   — script them directly, e.g. `client.auth.getUser.mockResolvedValue(...)`.

function createChainableBuilder(state) {
  const builder = {};

  const chainMethods = [
    'from', 'select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'lt', 'gt',
    'order', 'range', 'limit', 'ilike', 'like', 'or', 'filter',
    'contains', 'textSearch',
  ];

  for (const method of chainMethods) {
    builder[method] = jest.fn((...args) => {
      // `.delete({ count: 'exact' })` and similar option-passing calls
      // are recorded but otherwise behave like any other chain link.
      state.calls.push({ method, args });
      return builder;
    });
  }

  function nextResponse() {
    const resp = state.responses[state.callIndex] ?? { data: null, error: null, count: 0 };
    state.callIndex += 1;
    return resp;
  }

  builder.single = jest.fn(() => Promise.resolve(nextResponse()));
  builder.maybeSingle = jest.fn(() => Promise.resolve(nextResponse()));

  // Makes `await builder` and `await builder.select(...)` etc. work
  // directly (no terminal .single()/.maybeSingle()/.then() call needed),
  // exactly like a real supabase-js PostgrestFilterBuilder, which is a
  // thenable.
  builder.then = (resolve, reject) => {
    try {
      resolve(nextResponse());
    } catch (err) {
      reject(err);
    }
  };
  builder.catch = (reject) => builder.then(undefined, reject);

  return builder;
}

function createStorageBuilder(state) {
  return {
    from: jest.fn(() => ({
      createSignedUploadUrl: jest.fn(() => Promise.resolve(state.storageResponses[state.storageCallIndex++] ?? { data: { signedUrl: 'https://storage.test/signed-upload' }, error: null })),
      createSignedUrl:       jest.fn(() => Promise.resolve(state.storageResponses[state.storageCallIndex++] ?? { data: { signedUrl: 'https://storage.test/signed-download' }, error: null })),
      download:               jest.fn(() => Promise.resolve(state.storageResponses[state.storageCallIndex++] ?? { data: { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }, error: null })),
      remove:                 jest.fn(() => Promise.resolve(state.storageResponses[state.storageCallIndex++] ?? { data: [{}], error: null })),
    })),
  };
}

/**
 * Creates a fresh mock Supabase client instance. Call once per test file
 * (typically inside a jest.mock() factory), and use the returned control
 * methods inside individual tests / beforeEach blocks to script
 * responses and make assertions.
 */
function mockSupabase() {
  const state = {
    calls: [],
    responses: [],
    callIndex: 0,
    rpcCalls: [],
    rpcResponses: [],
    rpcCallIndex: 0,
    storageResponses: [],
    storageCallIndex: 0,
  };

  const builder = createChainableBuilder(state);
  const storage = createStorageBuilder(state);

  const client = {
    from: jest.fn((table) => {
      state.calls.push({ method: 'from', args: [table] });
      return builder;
    }),
    rpc: jest.fn((fnName, params) => {
      state.rpcCalls.push({ fnName, params });
      const resp = state.rpcResponses[state.rpcCallIndex] ?? { data: null, error: null };
      state.rpcCallIndex += 1;
      return Promise.resolve(resp);
    }),
    storage,
    auth: {
      getUser: jest.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      signInWithPassword: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      signUp: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      refreshSession: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      resetPasswordForEmail: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      verifyOtp: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      exchangeCodeForSession: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      admin: {
        signOut: jest.fn(() => Promise.resolve({ error: null })),
        updateUserById: jest.fn(() => Promise.resolve({ data: {}, error: null })),
        getUserById: jest.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      },
    },
  };

  return {
    client,
    builder,

    /** Push the response for the NEXT sequential .single()/.maybeSingle()/await call. */
    mockNextResponse: (resp) => state.responses.push(resp),

    /** Push several responses at once, in call order. */
    mockResponses: (...resps) => state.responses.push(...resps),

    /** Push the response for the NEXT .rpc() call. */
    mockNextRpcResponse: (resp) => state.rpcResponses.push(resp),

    /** Push the response for the NEXT .storage.from(...).<method>() call. */
    mockNextStorageResponse: (resp) => state.storageResponses.push(resp),

    /** Introspection for assertions. */
    getCalls: () => state.calls,
    getRpcCalls: () => state.rpcCalls,

    /** Reset all scripted responses and call logs (call in afterEach if not using a fresh instance per test). */
    reset: () => {
      state.calls = [];
      state.responses = [];
      state.callIndex = 0;
      state.rpcCalls = [];
      state.rpcResponses = [];
      state.rpcCallIndex = 0;
      state.storageResponses = [];
      state.storageCallIndex = 0;
      jest.clearAllMocks();
    },
  };
}

module.exports = { mockSupabase };
