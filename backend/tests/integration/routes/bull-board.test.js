// tests/integration/routes/bull-board.test.js
//
// Doc 3 Section 6 — Bull Board Admin Panel (app.js, conditional mount).
// Since the mount itself is conditional on env vars read at module-load
// time, tests toggling BULL_BOARD_USERNAME/PASSWORD use resetTestApp()
// to force a genuinely fresh require('../../src/app') under each env
// state, per testApp.js's own documented purpose for this exact case.

const request = require('supertest');
const { getTestApp, resetTestApp } = require('../../helpers/testApp');

describe('Bull Board admin panel — /admin/queues', () => {
  const originalUsername = process.env.BULL_BOARD_USERNAME;
  const originalPassword = process.env.BULL_BOARD_PASSWORD;
  const originalWhitelist = process.env.ADMIN_IP_WHITELIST;

  afterEach(() => {
    process.env.BULL_BOARD_USERNAME = originalUsername;
    process.env.BULL_BOARD_PASSWORD = originalPassword;
    process.env.ADMIN_IP_WHITELIST = originalWhitelist;
    resetTestApp();
    jest.resetModules();
  });

  it('env vars unset -> /admin/queues is never mounted (404, not 401)', async () => {
    delete process.env.BULL_BOARD_USERNAME;
    delete process.env.BULL_BOARD_PASSWORD;
    resetTestApp();
    jest.resetModules();
    const app = getTestApp();

    const res = await request(app).get('/admin/queues');
    expect(res.status).toBe(404);
  });

  describe('with BULL_BOARD_USERNAME/PASSWORD set', () => {
    function setupMountedApp() {
      process.env.BULL_BOARD_USERNAME = 'admin';
      process.env.BULL_BOARD_PASSWORD = 'supersecret';
      resetTestApp();
      jest.resetModules();
      return getTestApp();
    }

    it('no Authorization header -> 401 with WWW-Authenticate: Basic', async () => {
      process.env.ADMIN_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
      const app = setupMountedApp();

      const res = await request(app).get('/admin/queues/');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Basic');
    });

    it('wrong credentials -> 401', async () => {
      process.env.ADMIN_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';
      const app = setupMountedApp();

      const res = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'wrongpassword');
      expect(res.status).toBe(401);
    });

    it('correct credentials but disallowed IP -> 403, BEFORE credentials are even checked', async () => {
      process.env.ADMIN_IP_WHITELIST = '198.51.100.1'; // deliberately NOT our test request's IP
      const app = setupMountedApp();

      // Correct credentials AND a disallowed IP — must be 403 (IP check
      // wins), not 401 (which would imply creds were checked first).
      const res = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'supersecret')
        .set('X-Forwarded-For', '203.0.113.99');

      expect(res.status).toBe(403);
    });

    it('CIDR-range entry: an IP inside the range is allowed; just outside is denied (boundary)', async () => {
      process.env.ADMIN_IP_WHITELIST = '203.0.113.0/29'; // covers .0-.7
      const app = setupMountedApp();

      const insideRes = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'supersecret')
        .set('X-Forwarded-For', '203.0.113.5'); // inside /29
      // trust proxy is set to 1, so req.ip reflects X-Forwarded-For.
      expect(insideRes.status).not.toBe(403);

      const outsideRes = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'supersecret')
        .set('X-Forwarded-For', '203.0.113.9'); // just outside /29
      expect(outsideRes.status).toBe(403);
    });

    it('a malformed whitelist entry does not throw — ipInCidr returns false safely', async () => {
      process.env.ADMIN_IP_WHITELIST = 'not-an-ip-or-cidr-at-all';
      const app = setupMountedApp();

      const res = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'supersecret')
        .set('X-Forwarded-For', '203.0.113.5');

      // Must resolve to a clean 403 (falls through isIpAllowed's .some()
      // returning false), not a 500 from a thrown exception.
      expect(res.status).toBe(403);
    });

    it('correct credentials AND an allowed IP succeeds (not 401/403)', async () => {
      process.env.ADMIN_IP_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1,203.0.113.0/24';
      const app = setupMountedApp();

      const res = await request(app)
        .get('/admin/queues/')
        .auth('admin', 'supersecret')
        .set('X-Forwarded-For', '203.0.113.5');

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});
