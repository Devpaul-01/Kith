// src/config/redis-keys.js
//
// Central place for Redis key naming used outside of BullMQ/rate-limit-
// redis (which manage their own prefixes internally). Keeping these here
// avoids magic strings scattered across auth.js, workspace.js, etc., and
// makes it obvious at a glance what's cached and for how long.

const TTL = {
  LAST_SEEN_DEBOUNCE_SECONDS:    5 * 60, // matches previous in-memory LAST_SEEN_STALE_MS
  MEMBERSHIP_CACHE_SECONDS:      30,     // requireMembership cache (see middleware/workspace.js)
  DASHBOARD_CACHE_SECONDS:       30,     // workspace dashboard aggregation (see services/dashboard.service.js)
  OVERDUE_SUMMARY_CACHE_SECONDS: 60,     // overdue-contributions aggregation (admin only, changes less often)
};

const lastSeenKey   = (userId) => `kith:lastseen:${userId}`;
const membershipKey = (workspaceId, userId) => `kith:membership:${workspaceId}:${userId}`;

// isAdmin is part of the key because the dashboard payload itself differs
// by role (pending_confirmations is admin-only) — caching one shared blob
// across roles would either leak admin-only data to members or force an
// isAdmin check on every cached read. Per-member fields (unread counts)
// are deliberately NOT part of this cached payload — see dashboard.service.js.
const dashboardKey      = (workspaceId, isAdmin) => `kith:dashboard:${workspaceId}:${isAdmin ? 'admin' : 'member'}`;
const overdueSummaryKey = (workspaceId) => `kith:overdue-summary:${workspaceId}`;

module.exports = { TTL, lastSeenKey, membershipKey, dashboardKey, overdueSummaryKey };
