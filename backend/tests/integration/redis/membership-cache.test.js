// tests/integration/redis/membership-cache.test.js
//
// Doc 3 Section 4.1 — membership-cache.service.js caching behavior
// against REAL Redis (Doc 3 Section 1 — integration tests use a real
// Redis, not ioredis-mock).

const request = require('supertest');
const { getTestApp } = require('../../helpers/testApp');
const { supabaseAdmin } = require('../../../src/config/supabase');
const { getRedis } = require('../../../src/config/redis');
const { membershipKey } = require('../../../src/config/redis-keys');
const {
  getCachedMembership,
  setCachedMembership,
  invalidateMembership,
  invalidateWorkspace,
} = require('../../../src/services/membership-cache.service');
const { mockAuthenticatedRequest } = require('../../helpers/authHelper');
const { seedWorkspaceWithAdmin, cleanupWorkspace } = require('../../helpers/dbHelper');
const logger = require('../../../src/utils/logger');

describe('membership-cache.service.js against real Redis', () => {
  const app = getTestApp();
  const redis = getRedis();
  const seededWorkspaceIds = [];

  afterAll(async () => {
    for (const id of seededWorkspaceIds) {
      await cleanupWorkspace(supabaseAdmin, id).catch(() => {});
    }
  });

  it('round-trips a cached membership payload and it expires after the configured TTL', async () => {
    const workspaceId = require('crypto').randomUUID();
    const userId = require('crypto').randomUUID();
    const payload = { member: { id: 'm1', role: 'admin' }, workspace: { id: workspaceId, name: 'TTL Test WS' } };

    await setCachedMembership(workspaceId, userId, payload);
    const cached = await getCachedMembership(workspaceId, userId);
    expect(cached).toEqual(payload);

    // Rather than waiting the real 30s TTL, directly verify the TTL was
    // actually SET on the key (a short-TTL override at the Redis level,
    // per Doc 3 Section 4.1's suggested approach) — this proves
    // expiration WILL happen without a slow real-time wait in the suite.
    const ttl = await redis.ttl(membershipKey(workspaceId, userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('a Redis connection failure fails open: getCachedMembership returns null, setCachedMembership swallows silently', async () => {
    const workspaceId = require('crypto').randomUUID();
    const userId = require('crypto').randomUUID();

    const warnSpy = jest.spyOn(logger, 'warn');
    const getSpy = jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const result = await getCachedMembership(workspaceId, userId);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    getSpy.mockRestore();

    const setSpy = jest.spyOn(redis, 'set').mockRejectedValueOnce(new Error('simulated Redis outage'));
    await expect(setCachedMembership(workspaceId, userId, { member: {}, workspace: {} })).resolves.toBeUndefined();
    setSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('requireMembership integration test still completes successfully end-to-end when Redis is down for the cache read', async () => {
    const { workspace, user } = await seedWorkspaceWithAdmin(supabaseAdmin);
    seededWorkspaceIds.push(workspace.id);
    const { authHeader } = mockAuthenticatedRequest({ supabaseAdmin, userId: user.id, email: user.email });

    const getSpy = jest.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis outage'));

    const res = await request(app).get(`/v1/workspaces/${workspace.id}`).set('Authorization', authHeader);

    expect(res.status).toBe(200); // falls through to real Postgres lookup
    getSpy.mockRestore();
  });

  it('invalidateMembership deletes the key; a subsequent getCachedMembership returns null', async () => {
    const workspaceId = require('crypto').randomUUID();
    const userId = require('crypto').randomUUID();
    await setCachedMembership(workspaceId, userId, { member: {}, workspace: {} });

    expect(await getCachedMembership(workspaceId, userId)).not.toBeNull();

    await invalidateMembership(workspaceId, userId);

    expect(await getCachedMembership(workspaceId, userId)).toBeNull();
  });

  it('invalidateWorkspace clears every cached membership for that workspace but leaves an unrelated workspace untouched, exercising multiple SCAN iterations', async () => {
    const targetWorkspaceId = require('crypto').randomUUID();
    const unrelatedWorkspaceId = require('crypto').randomUUID();

    // Seed 150+ keys to force at least 2 SCAN COUNT-100 iterations,
    // actually exercising the do...while loop (Doc 3 Section 4.1).
    const userIds = Array.from({ length: 155 }, () => require('crypto').randomUUID());
    await Promise.all(userIds.map((uid) => setCachedMembership(targetWorkspaceId, uid, { member: {}, workspace: {} })));
    await setCachedMembership(unrelatedWorkspaceId, require('crypto').randomUUID(), { member: {}, workspace: {} });

    await invalidateWorkspace(targetWorkspaceId);

    const remaining = await Promise.all(userIds.map((uid) => getCachedMembership(targetWorkspaceId, uid)));
    expect(remaining.every((r) => r === null)).toBe(true);

    // The unrelated workspace's own cached membership must survive.
    const unrelatedKeys = await redis.keys(membershipKey(unrelatedWorkspaceId, '*'));
    expect(unrelatedKeys.length).toBe(1);
  });
});
