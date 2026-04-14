const request = require('supertest');
const app     = require('../../src/app');

// Don't mock requireAuth — test that real auth rejection works
jest.mock('../../src/config/supabase');
const { supabaseAdmin } = require('../../src/config/supabase');

describe('Workspace routes — authentication enforcement', () => {

  test('should return 401 for DELETE /v1/workspaces/:id with no token', async () => {
    // ACT — no Authorization header
    const response = await request(app)
      .delete('/v1/workspaces/ws-123');

    // ASSERT
    expect(response.status).toBe(401);
  });

  test('should return 401 for GET /v1/workspaces with an invalid token', async () => {
    // ARRANGE — mock Supabase to simulate invalid token
    supabaseAdmin.auth = {
      getUser: jest.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid JWT', status: 401 }
      })
    };

    // ACT
    const response = await request(app)
      .get('/v1/workspaces')
      .set('Authorization', 'Bearer invalid-token');

    // ASSERT
    expect(response.status).toBe(401);
  });

});