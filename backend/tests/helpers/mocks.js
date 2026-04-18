function createSupabaseMock() {
  // Create a single chainable object
  const chainable = {
    // Query methods
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    
    // Filter methods
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    
    // Pagination
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    
    // Single row methods
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    
    // Promise methods (this is the key!)
    then: jest.fn().mockResolvedValue({ data: null, error: null }),
    catch: jest.fn().mockReturnThis(),
  };

  return {
    from: jest.fn().mockReturnValue(chainable),
    auth: {
      getUser: jest.fn(),
      admin: {
        getUserById: jest.fn(),
        signOut: jest.fn(),
        updateUserById: jest.fn(),
      },
    },
    rpc: jest.fn(),
  };
}


/** Minimal Express req object — override what you need */
function buildReq(overrides = {}) {
  return {
    headers:   {},
    params:    {},
    query:     {},
    body:      {},
    ip:        '127.0.0.1',
    requestId: 'test-req-id',
    method:    'GET',
    path:      '/test',
    user:      null,
    member:    null,
    workspace: null,
    dbUser:    null,
    ...overrides,
  };
}

/** Minimal Express res object with jest spies */
function buildRes() {
  return {
    status:    jest.fn().mockReturnThis(),
    json:      jest.fn().mockReturnThis(),
    send:      jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
  };
}

/** Standard workspace member for req.member */
function buildMember(overrides = {}) {
  return {
    id:          'member-test-1',
    role:        'member',
    displayName: 'Test User',
    isProxy:     false,
    isActive:    true,
    workspaceId: 'workspace-test-1',
    ...overrides,
  };
}

/** Standard workspace for req.workspace */
function buildWorkspace(overrides = {}) {
  return {
    id:           'workspace-test-1',
    name:         'Test Family',
    baseCurrency: 'GBP',
    plan:         'free',
    visibility:   'private',
    ...overrides,
  };
}

/** Standard auth user for req.user */
function buildUser(overrides = {}) {
  return {
    id:        'user-test-1',
    email:     'test@example.com',
    full_name: 'Test User',
    ...overrides,
  };
}

module.exports = {
  createSupabaseMock,
  buildReq,
  buildRes,
  buildMember,
  buildWorkspace,
  buildUser,
};