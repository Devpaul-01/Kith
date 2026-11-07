const { ResilientRateLimitStore } = require('../../../src/middleware/resilient-rate-limit-store');

describe('rate limiter Redis outage fallback', () => {
  let remote;
  let store;
  beforeEach(() => {
    jest.useFakeTimers();
    remote = { init: jest.fn(), increment: jest.fn(), decrement: jest.fn(), resetKey: jest.fn() };
    store = new ResilientRateLimitStore(remote, 'rl:agent:');
    store.init({ windowMs: 60000 });
  });
  afterEach(() => { store.shutdown(); jest.useRealTimers(); });

  it('preserves local counts through failure and recovery while honoring larger shared counts', async () => {
    remote.increment.mockResolvedValueOnce({ totalHits: 5, resetTime: new Date(Date.now() + 60000) })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ totalHits: 1, resetTime: new Date(Date.now() + 60000) });
    expect((await store.increment('user')).totalHits).toBe(5);
    expect((await store.increment('user')).totalHits).toBe(2);
    expect((await store.increment('user')).totalHits).toBe(3);
    expect((await store.increment('other-user')).totalHits).toBe(1);
  });

  it('does not reset the process counter when Redis fails after ten accepted calls', async () => {
    remote.increment.mockRejectedValue(new Error('offline'));
    for (let i = 1; i <= 11; i += 1) expect((await store.increment('user')).totalHits).toBe(i);
    await jest.advanceTimersByTimeAsync(60001);
    expect((await store.increment('user')).totalHits).toBe(1);
  });

  it('falls back for malformed shared counters and supports resets', async () => {
    remote.increment.mockResolvedValue({ totalHits: NaN, resetTime: new Date() });
    expect((await store.increment('user')).totalHits).toBe(1);
    await store.decrement('user');
    expect((await store.increment('user')).totalHits).toBe(1);
    await store.resetKey('user');
    expect((await store.increment('user')).totalHits).toBe(1);
  });
});
