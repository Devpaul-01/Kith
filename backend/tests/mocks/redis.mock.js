// tests/mocks/redis.mock.js
//
// Thin wrapper choosing ioredis-mock (fast, in-memory, no network) for
// unit tests, or letting integration tests fall through to the REAL
// ioredis client (config/redis.js's getRedis(), pointed at the Docker
// test Redis via REDIS_URL set in tests/setup.integration.js /
// tests/setup.ratelimit.js) — selected via an env flag so the SAME
// import shape works in both contexts without a test file needing to
// know which mode it's in.
//
// USAGE (unit tests only — integration tests should NOT use this file;
// they import the real '../../src/config/redis' directly):
//
//   jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
//
// This mocks getRedis() to return a shared ioredis-mock instance for the
// lifetime of the test file, and checkConnection() to resolve true.
//
// NOTE: ioredis-mock supports the SET...NX EX pattern used by
// middleware/auth.js#shouldUpdateLastSeen and the RedisStore usage in
// middleware/rateLimiter.js reasonably well for unit-test purposes, but
// its SCAN implementation (used by
// services/membership-cache.service.js#invalidateWorkspace) has had
// historical edge-case gaps versus real Redis — any test asserting SCAN
// cursor-loop behavior specifically should live in
// tests/integration/redis/*, against the real Redis, not here.

let sharedInstance = null;

function getRedis() {
  if (!sharedInstance) {
    const RedisMock = require('ioredis-mock');
    sharedInstance = new RedisMock();
  }
  return sharedInstance;
}

async function checkConnection() {
  try {
    const r = getRedis();
    await r.ping();
    return true;
  } catch {
    return false;
  }
}

/** Test-only helper: reset the shared mock instance between test files if needed. */
function __resetRedisMock() {
  if (sharedInstance) {
    sharedInstance.flushall();
  }
  sharedInstance = null;
}

module.exports = { getRedis, checkConnection, __resetRedisMock };
