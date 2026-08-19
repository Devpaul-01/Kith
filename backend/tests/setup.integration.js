// tests/setup.integration.js
//
// Runs via Jest's `setupFilesAfterEnv` for the "integration" project.
// Integration tests hit REAL Postgres (docker-compose.test.yml's
// postgres-test service) and REAL Redis (redis-test), but mock external
// SaaS (Firebase/Resend) always — see tests/mocks/firebase.mock.js and
// tests/mocks/resend.mock.js, and Doc 3 Section 1's "mock external SaaS
// always" rule referenced in tests/mocks/README.md.
//
// process.env.NODE_ENV stays 'test' here (unlike setup.ratelimit.js)
// specifically so rateLimiter.js's `skip: (req) => process.env.NODE_ENV
// === 'test'` bypasses rate limiting for every OTHER integration suite —
// only tests/integration/redis/rate-limiting.test.js needs limiters to
// actually engage, and that suite runs under the separate "rate-limit"
// Jest project (setup.ratelimit.js) specifically to get a different
// NODE_ENV before its own app.js import happens.

const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';

// FIX (see docker-compose.test.yml's header comment): SUPABASE_URL must
// point at PostgREST (the REST API layer supabase-js actually talks to),
// not at Postgres's own wire-protocol port. Overridable via
// TEST_SUPABASE_URL for CI or alternate local setups.
process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL || 'http://localhost:3001';

// FIX: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY must be real signed
// JWTs, not plain placeholder strings — PostgREST decodes the bearer
// token as a JWT (header.payload.signature) to determine which Postgres
// role to SET ROLE as via the `role` claim. A non-JWT string fails with
// JWSError (CompactDecodeError: Expected 3 parts; got 1) on every query.
// Signed with the same secret docker-compose.test.yml's PGRST_JWT_SECRET
// uses (both read from TEST_JWT_SECRET so they can't drift apart).
// role: 'postgres' matches PGRST_DB_ANON_ROLE in docker-compose.test.yml;
// role: 'anon' is the conventional PostgREST anon-client role.
const JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || jwt.sign({ role: 'postgres' }, JWT_SECRET);
process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY || jwt.sign({ role: 'anon' }, JWT_SECRET);

// Dedicated Redis DB index (1) so this never collides with a developer's
// local dev-server Redis (DB 0) if both happen to be running against the
// same Redis host/port during local test runs.
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:63790/1';

process.env.FRONTEND_URL = 'https://app.test.local';
process.env.API_BASE_URL = 'http://localhost:3000';
process.env.STORAGE_BUCKET_NAME = 'kith-files-test';
process.env.ALLOWED_DEEPLINK_SCHEMES = 'kithapp://';
process.env.IDEMPOTENCY_ENABLED = 'true';
process.env.FILE_VERIFICATION_ENABLED = 'false'; // integration tests don't upload real bytes to real storage by default
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-secret';

// External SaaS mocks — ALWAYS mocked, even in integration tests, per
// Doc 3 Section 1. Real Postgres/Redis, fake Firebase/Resend.
jest.mock('../src/config/firebase', () => require('./mocks/firebase.mock'));
jest.mock('../src/config/resend',   () => require('./mocks/resend.mock'));

const { getRedis } = require('../src/config/redis');

// Doc 4 Section 2.4: Redis is FLUSHDB'd between test FILES (not
// individual tests) — every test within a file that touches
// Redis-cached data must use a freshly-generated workspace/user ID per
// test (via factory counters) rather than a shared constant ID, to avoid
// one test's cached state leaking into the next test in the SAME file.
// See tests/helpers/dbHelper.js's header comment for the full rationale.
beforeAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
});

afterAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
  await redis.quit();
});

afterEach(() => {
  jest.clearAllMocks();
});

// Generous default timeout bump is already set via the Jest project's
// testTimeout: 30000 (package.test.json) — not repeated here.
