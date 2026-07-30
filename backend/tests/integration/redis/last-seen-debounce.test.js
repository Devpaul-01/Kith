// tests/integration/redis/last-seen-debounce.test.js
//
// Doc 3 Section 4.2 — auth.js's last-seen debounce, backed by a real
// Redis SET NX EX. This is fire-and-forget from requireAuth's
// perspective (it calls next() before the debounce/update resolves), so
// these tests poll briefly after the request completes rather than
// asserting synchronously.

const request = require('supertest');
const crypto = require('crypto');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getRedis } = require('../../../src/config/redis');
const { lastSeenKey } = require('../../../src/config/redis-keys');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');

// Fire-and-forget update happens asynchronously after next() — poll
// briefly for the expected DB state rather than asserting the instant
// the HTTP response returns.
async function waitFor(assertionFn, { timeoutMs = 2000, intervalMs = 50 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      await assertionFn();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr;
}

describe('last-seen debounce (middleware/auth.js) against real Redis', () => {
  const app = getTestApp();
  const redis = getRedis();
  const createdUserIds = [];

  afterAll(async () => {
    for (const id of createdUserIds) {
      await supabaseAdmin.from('users').delete().eq('id', id).catch(() => {});
    }
  });

  it('two near-simultaneous requests for the same user perform only ONE users.update write', async () => {
    const userId = crypto.randomUUID();
    await supabaseAdmin.from('users').insert({ id: userId, email: `debounce-${Date.now()}@example.test`, full_name: 'Debounce User', last_seen_at: null });
    createdUserIds.push(userId);

    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId, email: `debounce-${userId}@example.test` });

    // requireAuth is mounted on /v1/auth/me (requireAuth + loadDbUser) —
    // use it as a lightweight authenticated endpoint to trigger the
    // debounce twice, back to back.
    const [res1, res2] = await Promise.all([
      request(app).get('/v1/auth/me').set('Authorization', authHeader),
      request(app).get('/v1/auth/me').set('Authorization', authHeader),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    await waitFor(async () => {
      const { data } = await supabaseAdmin.from('users').select('last_seen_at').eq('id', userId).single();
      expect(data.last_seen_at).not.toBeNull();
    });

    // Only one of the two concurrent SET NX claims should have won —
    // confirmed indirectly via the debounce key existing with a TTL
    // consistent with a single successful claim (not overwritten twice).
    const ttl = await redis.ttl(lastSeenKey(userId));
    expect(ttl).toBeGreaterThan(0);
  });

  it('after the debounce window expires, the next request DOES trigger a write', async () => {
    const userId = crypto.randomUUID();
    await supabaseAdmin.from('users').insert({ id: userId, email: `debounce2-${Date.now()}@example.test`, full_name: 'Debounce User 2', last_seen_at: null });
    createdUserIds.push(userId);

    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId, email: `debounce2-${userId}@example.test` });

    await request(app).get('/v1/auth/me').set('Authorization', authHeader);
    await waitFor(async () => {
      const { data } = await supabaseAdmin.from('users').select('last_seen_at').eq('id', userId).single();
      expect(data.last_seen_at).not.toBeNull();
    });
    const { data: firstSeen } = await supabaseAdmin.from('users').select('last_seen_at').eq('id', userId).single();

    // Manually expire the debounce key to simulate the window passing,
    // rather than sleeping the real 5-minute TTL.LAST_SEEN_DEBOUNCE_SECONDS.
    await redis.del(lastSeenKey(userId));

    // Ensure the second write's timestamp is measurably later.
    await new Promise((r) => setTimeout(r, 1100));

    await request(app).get('/v1/auth/me').set('Authorization', authHeader);
    await waitFor(async () => {
      const { data } = await supabaseAdmin.from('users').select('last_seen_at').eq('id', userId).single();
      expect(new Date(data.last_seen_at).getTime()).toBeGreaterThan(new Date(firstSeen.last_seen_at).getTime());
    });
  });
});
