// tests/helpers/testApp.js
//
// Builds a supertest-ready instance of the real src/app.js for
// INTEGRATION tests, with external SaaS (Firebase/Resend) mocked per the
// "mock external SaaS always" rule and real Postgres/Redis wired via the
// env vars tests/setup.integration.js already set before this file's
// require('../../src/app') executes.
//
// USAGE:
//   const request = require('supertest');
//   const { getTestApp } = require('../../helpers/testApp');
//
//   describe('POST /v1/workspaces', () => {
//     it('creates a workspace', async () => {
//       const app = getTestApp();
//       const res = await request(app)
//         .post('/v1/workspaces')
//         .set('Authorization', bearerHeaderFor(token))
//         .send({ name: 'The Smiths', base_currency: 'USD' });
//       expect(res.status).toBe(201);
//     });
//   });
//
// Why a function instead of exporting the app directly: app.js does a
// fair amount of module-load-time work (Bull Board conditional wiring,
// CORS/helmet setup) that should only happen once the right env vars are
// definitely in place (i.e. after setupFilesAfterEnv has run) — wrapping
// require('../../src/app') in a function and calling it lazily from
// inside a test file (not at this helper's own module-load time) avoids
// any require-ordering surprises across different test files/projects
// that might import this helper before their own setup file has fully
// applied.

let cachedApp = null;

function getTestApp() {
  if (!cachedApp) {
    // Require lazily so this only happens once a project's
    // setupFilesAfterEnv (setup.integration.js / setup.ratelimit.js) has
    // already set process.env and mocked config/firebase + config/resend.
    cachedApp = require('../../src/app');
  }
  return cachedApp;
}

/**
 * Resets the cached app reference. Jest's module registry is normally
 * isolated per test FILE already (so this is rarely needed), but exposed
 * for the rare integration test that needs to re-require app.js under
 * different env vars within the same file (e.g. toggling
 * BULL_BOARD_USERNAME/PASSWORD to test the admin-guard branch).
 */
function resetTestApp() {
  cachedApp = null;
  jest.resetModules();
}

module.exports = { getTestApp, resetTestApp };
