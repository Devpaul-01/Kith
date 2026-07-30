// tests/setup.unit.js
//
// Runs via Jest's `setupFilesAfterEnv` for the "unit" project — AFTER the
// test framework itself is initialised but BEFORE any test file's own
// top-level code executes. This ordering matters: it's what lets us set
// process.env here and have it already be in place by the time a test
// file's `require('../../src/services/whatever.service')` transitively
// pulls in config/supabase.js, which reads these vars at module-load
// time and calls process.exit(1) if they're missing (see
// config/supabase.js's top-level guard). A beforeAll() inside an
// individual test file would run too late for that.
//
// Unit tests NEVER talk to real Postgres/Redis — every DB/Redis call is
// mocked at the module level (see tests/mocks/*). These env vars exist
// purely so config/supabase.js's startup guard and any code that reads
// process.env.FRONTEND_URL / etc. don't crash before the mocks take
// over.

process.env.NODE_ENV = 'test';

process.env.SUPABASE_URL = 'https://test.supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

process.env.REDIS_URL = 'redis://localhost:6379/1';

process.env.FRONTEND_URL = 'https://app.test.local';
process.env.API_BASE_URL = 'http://localhost:3000';

process.env.STORAGE_BUCKET_NAME = 'kith-files-test';

process.env.RESEND_API_KEY = '';        // intentionally unset-like — exercises the "not configured" branches
process.env.FIREBASE_SERVICE_ACCOUNT = ''; // same

process.env.ALLOWED_DEEPLINK_SCHEMES = 'kithapp://';

process.env.IDEMPOTENCY_ENABLED = 'true';
process.env.FILE_VERIFICATION_ENABLED = 'true';

process.env.LOG_LEVEL = 'silent'; // keep test output clean; winston still initialises fine with this

// Silence winston's console transport noise in unit test output while
// still letting logger.* calls execute (so code paths that pass a
// logger call aren't accidentally skipped/erroring).
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Global test lifecycle hygiene
afterEach(() => {
  jest.clearAllMocks();
});
