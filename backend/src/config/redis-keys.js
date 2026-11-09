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
  AGENT_BUDGET_RETENTION_SECONDS: 60 * 60, // retain the previous window for in-flight reconciliation
  AGENT_CONVERSATION_SECONDS:    30 * 60, // sliding expiry after a completed turn
  AGENT_CONVERSATION_LEASE_SECONDS: 10 * 60, // abandoned turns cannot lock a conversation forever
};

const lastSeenKey   = (userId) => `kith:lastseen:${userId}`;
const membershipKey = (workspaceId, userId) => `kith:membership:${workspaceId}:${userId}`;

// isAdmin is part of the key because the dashboard payload itself differs
// by role (pending_confirmations is admin-only) — caching one shared blob
// across roles would either leak admin-only data to members or force an
// isAdmin check on every cached read. Per-member fields (unread counts)
// are deliberately NOT part of this cached payload — see dashboard.service.js.
// v2 skips payloads cached before target/participant workspace isolation
// was enforced. Old keys expire normally without being served again.
const dashboardKey      = (workspaceId, isAdmin) => `kith:dashboard:v2:${workspaceId}:${isAdmin ? 'admin' : 'member'}`;
const overdueSummaryKey = (workspaceId) => `kith:overdue-summary:v2:${workspaceId}`;
const agentBudgetKey = (workspaceId, period, windowStartMs) => `kith:agent-budget:v1:${workspaceId}:${period}:${windowStartMs}`;
// The scope hashes the authenticated user, membership, workspace and role.
// Data and lease keys share a Redis Cluster hash slot for atomic updates.
const agentConversationKey = (scope, conversationId) => `kith:agent-conversation:v1:{${scope}:${conversationId}}`;

module.exports = { TTL, lastSeenKey, membershipKey, dashboardKey, overdueSummaryKey, agentBudgetKey, agentConversationKey };
