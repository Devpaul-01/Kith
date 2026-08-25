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

process.env.NODE_ENV = 'production'; // deliberately NOT 'test' — see header comment

// FIX (see docker-compose.test.yml's header comment): SUPABASE_URL must
// point at PostgREST, not at Postgres's own wire-protocol port.
process.env.SUPABASE_URL = process.env.TEST_SUPABASE_URL || 'http://localhost:3001';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY || 'test-anon-key';

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

beforeAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
});

afterAll(async () => {
  const redis = getRedis();
  await redis.flushdb();
  await redis.quit();
});
