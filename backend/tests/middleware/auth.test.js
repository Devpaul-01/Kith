
// tests/middleware/auth.test.js
const { requireAuth } = require('../../src/middleware/auth');

// You need to mock supabaseAdmincl
const {createSupabaseMock} = require('../helpers/mocks.js');

const supabaseAdmin = createSupabaseMock();




describe('requireAuth middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: {}, requestId: 'test-123', method: 'GET', path: '/test' };
    res = {};
    next = jest.fn();
  });

  it('calls next with UnauthorizedError when no Authorization header', async () => {
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next with UnauthorizedError when header is not Bearer', async () => {
    req.headers.authorization = 'Basic sometoken';
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('sets req.user and calls next() when token is valid', async () => {
  req.headers.authorization = 'Bearer valid-token';
  
  supabaseAdmin.auth.getUser.mockResolvedValue({
    data: { user: { id: 'user-1', email: 'test@test.com', user_metadata: {} } },
    error: null,
  });

  // Spy on the from method to see what's returned
  const fromSpy = jest.spyOn(supabaseAdmin, 'from');
  
  await requireAuth(req, res, next);

  // Debug: what was returned from from()?
  const chainReturned = fromSpy.mock.results[0]?.value;
  console.log('Chain returned:', chainReturned);
  console.log('Does chain have update?', !!chainReturned?.update);
  console.log('Does update().eq() exist?', !!chainReturned?.update?.()?.eq);
  console.log('Does eq().then exist?', !!chainReturned?.update?.()?.eq?.()?.then);

  expect(req.user).toEqual(expect.objectContaining({ id: 'user-1', email: 'test@test.com' }));
  expect(next).toHaveBeenCalledWith();
});

  it('calls next with UnauthorizedError when Supabase returns an error', async () => {
    req.headers.authorization = 'Bearer bad-token';
    supabaseAdmin.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Token expired', status: 401 },
    });

    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});