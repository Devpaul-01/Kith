// tests/integration/routes/health.test.js
//
// Doc 3 Section 7 — Health Check (GET /health). The final section of
// the Doc 3 test plan.
//
// NOTE: app.js's handler does `require('./config/database')` and
// `require('./config/redis')` INLINE inside the route callback, not at
// module top level — but since require() returns the same cached module
// exports object every time, jest.spyOn() on the object obtained via a
// top-level require here correctly intercepts the calls made inside the
// handler too.

const request = require('supertest');
const { getTestApp } = require('../../helpers/testApp');
const database = require('../../../src/config/database');
const redisConfig = require('../../../src/config/redis');

describe('GET /health', () => {
  const app = getTestApp();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('both DB and Redis healthy -> 200, status: ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.redis).toBe('connected');
  });

  it('DB healthy, Redis down -> 503, status: degraded, redis: error', async () => {
    jest.spyOn(redisConfig, 'checkConnection').mockResolvedValueOnce(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.redis).toBe('error');
    expect(res.body.db).toBe('connected');
  });

  it('DB down -> 503, db: error, regardless of Redis state', async () => {
    jest.spyOn(database, 'checkConnection').mockResolvedValueOnce(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
  });

  it('both down -> 503', async () => {
    jest.spyOn(database, 'checkConnection').mockResolvedValueOnce(false);
    jest.spyOn(redisConfig, 'checkConnection').mockResolvedValueOnce(false);

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    expect(res.body.redis).toBe('error');
  });

  it('an exception thrown during the check itself (not just a false return) is caught by the outer try/catch, 503 with the exception message', async () => {
    jest.spyOn(database, 'checkConnection').mockRejectedValueOnce(new Error('simulated unexpected exception'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('simulated unexpected exception');
  });
});
