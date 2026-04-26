
// tests/controllers/workspace.controller.test.js

const request    = require('supertest');
const app        = require('../../src/app');

// Mock all external dependencies
jest.mock('../../src/config/supabase');
jest.mock('../../src/middleware/auth'); // mock the auth middleware too
jest.mock('../../src/middleware/workspace');

const { supabaseAdmin }    = require('../../src/config/supabase');
const { requireAuth, loadDbUser } = require('../../src/middleware/auth');

// Make requireAuth and loadDbUser just call next() and set req.user
beforeEach(() => {
  requireAuth.mockImplementation((req, res, next) => {
    req.user = { id: 'user-123', email: 'test@example.com' };
    next();
  });
  loadDbUser.mockImplementation((req, res, next) => {
    req.dbUser = { id: 'user-123', full_name: 'Alice Test' };
    next();
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /v1/workspaces', () => {

  test('should create a workspace and return 201 with workspace and member', async () => {
    // ARRANGE — control what Supabase returns
    const fakeWorkspace = { id: 'ws-abc', name: 'Test Family', base_currency: 'GBP' };
    const fakeMember    = { id: 'mem-xyz', role: 'admin', workspace_id: 'ws-abc' };
    const fakeUser      = { full_name: 'Alice Test' };

    // Mock the chain of Supabase calls inside createWorkspace
    // First call: insert workspace
    // Second call: get user display name
    // Third call: insert member
    // Fourth call: insert default settings (3 rows)
    supabaseAdmin.from.mockImplementation((table) => {
      if (table === 'workspaces') {
        return {
          insert: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeWorkspace, error: null }),
        };
      }
      if (table === 'users') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeUser, error: null }),
        };
      }
      if (table === 'workspace_members') {
        return {
          insert: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: fakeMember, error: null }),
        };
      }
      if (table === 'workspace_settings') {
        return {
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      }
    });

    // ACT
    const response = await request(app)
      .post('/v1/workspaces')
      .set('Authorization', 'Bearer fake-token')
      .send({ name: 'Test Family', base_currency: 'GBP', family_type: 'extended' });
      
    

    // ASSERT
    expect(response.status).toBe(201);
    expect(response.body.data.workspace.id).toBe('ws-abc');
    expect(response.body.data.member.role).toBe('admin');
  });

  test('should return 400 when name is missing', async () => {
    // ARRANGE — body is intentionally invalid (missing required 'name')

    // ACT
    const response = await request(app)
      .post('/v1/workspaces')
      .set('Authorization', 'Bearer fake-token')
      .send({ base_currency: 'GBP' }); // missing 'name'

    // ASSERT
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

});