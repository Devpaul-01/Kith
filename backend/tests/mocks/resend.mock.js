// tests/mocks/resend.mock.js
//
// jest.fn()-based mock of config/resend.js's getResend().emails.send(),
// used unconditionally (even in integration tests — Doc 3 Section 1's
// "mock external SaaS always" rule). We never want a test run to
// actually attempt to send a real email via Resend.
//
// USAGE:
//   jest.mock('../../src/config/resend', () => require('../mocks/resend.mock'));
//
// Then in a test:
//   const { __mockEmailsSend } = require('../../../tests/mocks/resend.mock');
//   expect(__mockEmailsSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'user@example.com' }));

const mockEmailsSend = jest.fn(() => Promise.resolve({ data: { id: 'mock-email-id' }, error: null }));

const mockResendClient = {
  emails: { send: mockEmailsSend },
};

function getResend() {
  return mockResendClient;
}

module.exports = {
  getResend,
  // Exposed for test assertions / resetting.
  __mockEmailsSend: mockEmailsSend,
  __resetResendMock: () => mockEmailsSend.mockClear(),
};
