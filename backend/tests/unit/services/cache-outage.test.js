jest.mock('../../../src/config/redis', () => ({ getRedis: jest.fn() }));
const { getRedis } = require('../../../src/config/redis');
const { getCachedMembership } = require('../../../src/services/membership-cache.service');
const { getCachedDashboard, getCachedOverdueSummary } = require('../../../src/services/dashboard-cache.service');

describe('cache reads during Redis outages', () => {
  afterEach(() => jest.useRealTimers());

  it('returns cache misses without queueing commands on a reconnecting client', async () => {
    const get = jest.fn();
    getRedis.mockReturnValue({ status: 'reconnecting', get });
    expect(await getCachedMembership('workspace', 'user')).toBeNull();
    expect(await getCachedDashboard('workspace', false)).toBeNull();
    expect(await getCachedOverdueSummary('workspace')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('bounds stalled reads and ignores results arriving after the deadline', async () => {
    jest.useFakeTimers();
    let resolveRead;
    getRedis.mockReturnValue({ status: 'ready', get: () => new Promise((resolve) => { resolveRead = resolve; }) });
    const pending = Promise.all([getCachedMembership('workspace', 'user'), getCachedDashboard('workspace', true), getCachedOverdueSummary('workspace')]);
    await jest.advanceTimersByTimeAsync(1001);
    expect(await pending).toEqual([null, null, null]);
    resolveRead('{"stale":true}');
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
  });
});
