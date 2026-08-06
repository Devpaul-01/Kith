// tests/helpers/mockReqRes.js
//
// Minimal Express req/res/next mocks for unit-testing middleware in
// isolation, per Doc 2 Section 3's approach: middleware functions take
// (req, res, next) and are pure enough to test without spinning up a
// real Express app. Full-stack middleware-chain testing belongs in
// integration tests, not here.

function mockReq(overrides = {}) {
  return {
    headers: {},
    params: {},
    query: {},
    ip: '127.0.0.1',
    path: '/test',
    method: 'GET',
    ...overrides,
  };
}

function mockRes(overrides = {}) {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  res.statusCode = 200;
  res._finishHandlers = [];
  res.on = jest.fn((event, handler) => {
    if (event === 'finish') res._finishHandlers.push(handler);
    return res;
  });
  res.triggerFinish = () => res._finishHandlers.forEach((h) => h());
  return Object.assign(res, overrides);
}

function mockNext() {
  return jest.fn();
}

/** Waits for pending microtasks to flush — needed for asserting on fire-and-forget async work. */
function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { mockReq, mockRes, mockNext, flushPromises };
