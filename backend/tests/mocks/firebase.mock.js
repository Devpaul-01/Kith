// tests/mocks/firebase.mock.js
//
// jest.fn()-based mock of config/firebase.js's getMessaging().send(),
// used unconditionally (even in integration tests — see Doc 3 Section 1's
// "mock external SaaS always" rule, referenced in
// tests/setup.integration.js and tests/setup.ratelimit.js). We never
// want a test run to actually attempt to deliver a push notification.
//
// USAGE:
//   jest.mock('../../src/config/firebase', () => require('../mocks/firebase.mock'));
//
// Then in a test:
//   const { __mockMessagingSend } = require('../../../tests/mocks/firebase.mock');
//   expect(__mockMessagingSend).toHaveBeenCalledWith(expect.objectContaining({ token: '...' }));

const mockMessagingSend = jest.fn(() => Promise.resolve({ successCount: 1 }));

const mockMessaging = {
  send: mockMessagingSend,
};

function getFirebaseApp() {
  return { name: 'mock-firebase-app' };
}

function getMessaging() {
  return mockMessaging;
}

module.exports = {
  getFirebaseApp,
  getMessaging,
  // Exposed for test assertions / resetting.
  __mockMessagingSend: mockMessagingSend,
  __resetFirebaseMock: () => mockMessagingSend.mockClear(),
};
