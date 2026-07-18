// src/services/membership-cache.service.js
//
// Short-lived (30s) Redis cache for requireMembership's per-request
// lookup of { member, workspace }. requireMembership runs on every
// single route in workspace.routes.js — dozens of endpoints — so this
// removes two DB round trips (workspace_members + workspaces) from the
// hot path for the large majority of requests, which arrive in bursts
// from the same user within a short window (e.g. a dashboard screen
// firing several sub-requests).
//
// SECURITY TRADEOFF (explicit, by design): authorization-relevant fields
// — role, is_active — are part of the cached payload. A change made
// through updateMember/deleteMember/deleteWorkspace is invalidated
// immediately via invalidateMembership()/invalidateWorkspace() below, so
// the only residual staleness window is for state changes made OUTSIDE
// this application (e.g. a direct DB edit) or any future write path that
// forgets to call invalidate — bounded to a maximum of
// TTL.MEMBERSHIP_CACHE_SECONDS (30s) either way. This tradeoff (bounded
// 30s staleness in exchange for removing 2 DB queries from every
// workspace-scoped request) was an explicit product decision, not an
// oversight — if a tighter bound is ever needed, lower
// TTL.MEMBERSHIP_CACHE_SECONDS in config/redis-keys.js rather than
// removing the cache.
//
// Fails open on Redis errors: a cache miss/error just means "fetch from
// Postgres like before," never a wrongly-granted or wrongly-denied
// request.

const { getRedis } = require('../config/redis');
const { TTL, membershipKey } = require('../config/redis-keys');
const logger = require('../utils/logger');

async function getCachedMembership(workspaceId, userId) {
  try {
    const redis = getRedis();
    const raw = await redis.get(membershipKey(workspaceId, userId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Membership cache read failed — falling back to DB', { workspaceId, userId, error: err.message });
    return null;
  }
}

async function setCachedMembership(workspaceId, userId, payload) {
  try {
    const redis = getRedis();
    await redis.set(
      membershipKey(workspaceId, userId),
      JSON.stringify(payload),
      'EX',
      TTL.MEMBERSHIP_CACHE_SECONDS
    );
  } catch (err) {
    logger.warn('Membership cache write failed', { workspaceId, userId, error: err.message });
  }
}

/** Invalidate one user's cached membership in one workspace. */
async function invalidateMembership(workspaceId, userId) {
  if (!workspaceId || !userId) return;
  try {
    const redis = getRedis();
    await redis.del(membershipKey(workspaceId, userId));
  } catch (err) {
    logger.warn('Membership cache invalidation failed', { workspaceId, userId, error: err.message });
  }
}

/**
 * Invalidate every cached membership for a workspace (e.g. on workspace
 * deletion). Uses SCAN rather than KEYS to avoid blocking Redis on large
 * keyspaces.
 */
async function invalidateWorkspace(workspaceId) {
  try {
    const redis = getRedis();
    const pattern = membershipKey(workspaceId, '*');
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Workspace-wide membership cache invalidation failed', { workspaceId, error: err.message });
  }
}

module.exports = {
  getCachedMembership,
  setCachedMembership,
  invalidateMembership,
  invalidateWorkspace,
};
