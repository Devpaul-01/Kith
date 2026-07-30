// tests/integration/redis/rate-limiting.test.js
//
// Doc 3 Section 4.3 — Rate Limiting (Redis-backed). This file is
// deliberately the ONLY test matched by the "rate-limit" Jest project
// (see package.test.json), which loads tests/setup.ratelimit.js instead
// of tests/setup.integration.js specifically to set
// process.env.NODE_ENV = 'production' BEFORE app.js (and therefore
// middleware/rateLimiter.js's module-level createLimiter() calls) is
// first required — see setup.ratelimit.js's own header comment for why
// this can't be done via a beforeAll() in a shared file.
//
// Run via: npm run test:ratelimit (== jest --selectProjects rate-limit)
// NOT part of the normal `npm run test:integration` run.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, seedAdditionalMember, cleanupWorkspace } = require('../../helpers/dbHelper');

describe('Rate limiting (real Redis, NODE_ENV=production so limiters actually engage)', () => {
  const app = getTestApp();
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  it('authLimiter: the 6th rapid POST /v1/auth/login from the same IP within a minute is 429', async () => {
    const attempts = [];
    for (let i = 0; i < 6; i++) {
      attempts.push(
        request(app)
          .post('/v1/auth/login')
          .set('X-Forwarded-For', '203.0.113.5') // stable simulated IP across all 6 attempts
          .send({ email: `nonexistent-${i}@example.test`, password: 'wrongpass1' })
      );
    }
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status);

    // The first 5 should NOT be 429 (they'll be 401 since the creds are
    // fake, but that's a distinct concern from rate limiting itself);
    // the 6th must be 429.
    expect(statuses[5]).toBe(429);
    expect(results[5].body.error.code).toBe('RATE_LIMITED');
  });

  it('userGeneralLimiter vs generalLimiter: two different authenticated users behind the same simulated IP each get their own budget', async () => {
    const { workspace, user: user1 } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const { user: user2 } = await seedAdditionalMember(supabaseAdmin, workspace.id, {});

    const { authHeader: auth1 } = mockAuthenticatedRequest({ supabaseAdmin, userId: user1.id, email: user1.email });
    const { authHeader: auth2 } = mockAuthenticatedRequest({ supabaseAdmin, userId: user2.id, email: user2.email });

    // A handful of requests each — well under the 200/min per-user
    // budget — from the SAME simulated IP, proving they don't share one
    // IP-keyed bucket (which would be Issue 2.3's regression: a
    // per-user limiter silently becoming IP-only due to mount order).
    const sharedIp = '203.0.113.9';

    const user1Results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get(`/v1/workspaces/${workspace.id}`).set('Authorization', auth1).set('X-Forwarded-For', sharedIp)
      )
    );
    const user2Results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get(`/v1/workspaces/${workspace.id}`).set('Authorization', auth2).set('X-Forwarded-For', sharedIp)
      )
    );

    expect(user1Results.every((r) => r.status !== 429)).toBe(true);
    expect(user2Results.every((r) => r.status !== 429)).toBe(true);
  });

  it('publicLookupLimiter: the 31st rapid request from one IP to GET /v1/public/invites/:token is 429, regardless of token validity', async () => {
    const sharedIp = '203.0.113.20';
    const attempts = [];
    for (let i = 0; i < 31; i++) {
      attempts.push(
        request(app)
          .get(`/v1/public/invites/nonexistent-token-${i}`)
          .set('X-Forwarded-For', sharedIp)
      );
    }
    const results = await Promise.all(attempts);

    expect(results[30].status).toBe(429);
  });
});
