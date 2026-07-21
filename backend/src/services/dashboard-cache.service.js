// src/services/dashboard-cache.service.js
//
// Short-lived (30s) Redis cache for the workspace dashboard aggregation
// (services/dashboard.service.js#getDashboardData). That aggregation is
// one of the heaviest reads in the app — up to 7 queries fanned out in
// parallel plus two more N+1-shaped follow-ups for target/container
// names — and the dashboard is the screen most likely to be polled or
// re-rendered repeatedly in a short window (tab focus, pull-to-refresh,
// navigating back to it).
//
// SCOPE, DELIBERATELY: only the workspace-wide, role-shared portion of
// the payload is cached (summary counts, active events, recurring pools,
// upcoming deadlines, pending confirmations, recent activity). The
// per-member fields — unread_notification_count and
// unread_activity_count — are excluded from the cached blob and always
// fetched fresh, because caching them would either go stale per-viewer
// or force the cache key to fan out per member (workspace_id x member_id),
// destroying the whole point of caching a workspace-wide aggregate. The
// cache key itself is still split by isAdmin (see redis-keys.js) since
// pending_confirmations is admin-only data that must never leak to a
// member via a shared cache entry.
//
// INVALIDATION: rather than hunting down and instrumenting every mutation
// across container/ledger/dispute/task/group/member/workspace services
// individually, this is invalidated from the one place nearly all of them
// already funnel through — audit.service.js#log(). Every mutation that
// shows up in the dashboard's recent_activity feed already calls
// audit.log(), so invalidating there is both comprehensive and avoids
// bolting cache-invalidation calls onto a dozen unrelated services. Any
// change that DOESN'T call audit.log() (there are none of enough
// materiality left in this codebase after the audit-coverage fixes) is
// still bounded by the 30s TTL either way.
//
// Fails open on Redis errors: a cache miss/error just means "compute it
// from Postgres like before," never stale-looking data being treated as
// an error.

const { getRedis } = require('../config/redis');
const { TTL, dashboardKey, overdueSummaryKey } = require('../config/redis-keys');
const logger = require('../utils/logger');

async function getCachedDashboard(workspaceId, isAdmin) {
  try {
    const redis = getRedis();
    const raw = await redis.get(dashboardKey(workspaceId, isAdmin));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('Dashboard cache read failed — falling back to DB', { workspaceId, error: err.message });
    return null;
  }
}

async function setCachedDashboard(workspaceId, isAdmin, payload) {
  try {
    const redis = getRedis();
    await redis.set(dashboardKey(workspaceId, isAdmin), JSON.stringify(payload), 'EX', TTL.DASHBOARD_CACHE_SECONDS);
  } catch (err) {
    logger.warn('Dashboard cache write failed', { workspaceId, error: err.message });
  }
}

async function getCachedOverdueSummary(workspaceId) {
  try {
    const redis = getRedis();
    const raw = await redis.get(overdueSummaryKey(workspaceId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('Overdue-summary cache read failed — falling back to DB', { workspaceId, error: err.message });
    return null;
  }
}

async function setCachedOverdueSummary(workspaceId, payload) {
  try {
    const redis = getRedis();
    await redis.set(overdueSummaryKey(workspaceId), JSON.stringify(payload), 'EX', TTL.OVERDUE_SUMMARY_CACHE_SECONDS);
  } catch (err) {
    logger.warn('Overdue-summary cache write failed', { workspaceId, error: err.message });
  }
}

/**
 * Invalidates both the admin and member dashboard views for a workspace,
 * plus its overdue summary. Fire-and-forget by design (called from
 * audit.service.js#log(), itself already fire-and-forget) — a failed
 * invalidation degrades to "stale for up to TTL seconds," not a bug.
 */
async function invalidateDashboard(workspaceId) {
  if (!workspaceId) return;
  try {
    const redis = getRedis();
    await redis.del(
      dashboardKey(workspaceId, true),
      dashboardKey(workspaceId, false),
      overdueSummaryKey(workspaceId)
    );
  } catch (err) {
    logger.warn('Dashboard cache invalidation failed', { workspaceId, error: err.message });
  }
}

module.exports = {
  getCachedDashboard,
  setCachedDashboard,
  getCachedOverdueSummary,
  setCachedOverdueSummary,
  invalidateDashboard,
};
