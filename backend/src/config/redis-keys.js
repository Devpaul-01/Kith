// src/config/redis-keys.js
//
// Central place for Redis key naming used outside of BullMQ/rate-limit-
// redis (which manage their own prefixes internally). Keeping these here
// avoids magic strings scattered across auth.js, workspace.js, etc., and
// makes it obvious at a glance what's cached and for how long.

const TTL = {
  LAST_SEEN_DEBOUNCE_SECONDS: 5 * 60,   // matches previous in-memory LAST_SEEN_STALE_MS
  MEMBERSHIP_CACHE_SECONDS:   30,       // requireMembership cache (see middleware/workspace.js)
};

const lastSeenKey   = (userId) => `kith:lastseen:${userId}`;
const membershipKey = (workspaceId, userId) => `kith:membership:${workspaceId}:${userId}`;

module.exports = { TTL, lastSeenKey, membershipKey };
