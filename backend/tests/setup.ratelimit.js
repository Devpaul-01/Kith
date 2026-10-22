// tests/setup.ratelimit.js
//
// Dedicated Jest project setup (see package.test.json's "rate-limit"
// project) whose entire reason to exist is ONE line: setting
// process.env.NODE_ENV to something other than 'test' BEFORE any
// require() of app.js (or anything that transitively requires
// middleware/rateLimiter.js) happens.
//
// Why this can't just be a beforeAll() in the integration setup file:
// middleware/rateLimiter.js builds each limiter with
//   skip: (req) => process.env.NODE_ENV === 'test'
// and that closure captures process.env.NODE_ENV *at the time
// createLimiter() runs*, which happens at require-time when app.js's
// module tree is first loaded — not per-request. By the time a
// beforeAll() in a shared setup file could flip NODE_ENV, app.js (and
// therefore rateLimiter.js) has typically already been required by an
// earlier-running test file sharing the same Jest worker's module
// registry. Only a dedicated Jest "project" — which gets its own
// setupFilesAfterEnv run before ITS OWN test files' top-level
// require()s — guarantees the env var is correct at the moment
// rateLimiter.js's module-level createLimiter() calls execute.
//
// Everything else mirrors setup.integration.js.

const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'production'; // deliberately NOT 'test' — see header comment

// FIX (see docker-compose.test.yml's header comment): SUPABASE_URL must
// point at PostgREST, not at Postgres's own wire-protocol port.
process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL || 'http://localhost:3001';

// FIX: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY must be real signed
// JWTs, not plain placeholder strings — PostgREST decodes the bearer
// token as a JWT (header.payload.signature) to determine which Postgres
// role to SET ROLE as via the `role` claim. A non-JWT string fails with
// JWSError (CompactDecodeError: Expected 3 parts; got 1) on every query
// the rate-limit suite's seed/cleanup helpers make through supabaseAdmin.
// Mirrors setup.integration.js's identical fix — signed with the same
// secret docker-compose.test.yml's PGRST_JWT_SECRET uses (both read from
// TEST_JWT_SECRET so they can't drift apart).
const JWT_SECRET = process.env.TEST_JWT_SECRET || 'test-jwt-secret-at-least-32-characters-long';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || jwt.sign({ role: 'postgres' }, JWT_SECRET);
process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY || jwt.sign({ role: 'anon' }, JWT_SECRET);

process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:63790/2'; // separate DB index from setup.integration.js's /1

process.env.FRONTEND_URL = 'https://app.test.local';
process.env.API_BASE_URL = 'http://localhost:3000';
process.env.STORAGE_BUCKET_NAME = 'kith-files-test';
process.env.ALLOWED_DEEPLINK_SCHEMES = 'kithapp://';
process.env.IDEMPOTENCY_ENABLED = 'true';
process.env.FILE_VERIFICATION_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

jest.mock('../src/config/firebase', () => require('./mocks/firebase.mock'));
jest.mock('../src/config/resend',   () => require('./mocks/resend.mock'));
jest.setTimeout(30000);
const { getRedis } = require('../src/config/redis');
const { closeQueues } = require('../src/queues');

beforeAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
});

afterAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
  // Safety net — see setup.integration.js's identical afterAll comment
  // for why this must run BEFORE redis.quit(): closes any BullMQ Queue
  // instances app.js may have created (its Bull Board mount is
  // conditional on BULL_BOARD_USERNAME/PASSWORD, not normally set for
  // this project, but closing unconditionally costs nothing when
  // there's nothing to close).
  await closeQueues();
  await redis.quit();
});
