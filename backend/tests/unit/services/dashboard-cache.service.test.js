// tests/unit/services/dashboard-cache.service.test.js
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../../../src/utils/logger');
const { getRedis, __resetRedisMock } = require('../../mocks/redis.mock');
const {
  getCachedDashboard, setCachedDashboard,
  getCachedOverdueSummary, setCachedOverdueSummary,
  invalidateDashboard,
} = require('../../../src/services/dashboard-cache.service');

describe('services/dashboard-cache.service', () => {
  beforeEach(() => {
    __resetRedisMock();
    jest.clearAllMocks();
  });

  describe('getCachedDashboard / setCachedDashboard', () => {
    it('round-trips a payload, keyed separately by isAdmin', async () => {
      await setCachedDashboard('ws-1', true, { summary: 'admin-view' });
      await setCachedDashboard('ws-1', false, { summary: 'member-view' });

      expect(await getCachedDashboard('ws-1', true)).toEqual({ summary: 'admin-view' });
      expect(await getCachedDashboard('ws-1', false)).toEqual({ summary: 'member-view' });
    });

    it('cache miss returns null', async () => {
      expect(await getCachedDashboard('ws-unknown', true)).toBeNull();
    });

    it('fails open on Redis read error (returns null, logs warning)', async () => {
      const redis = getRedis();
      const original = redis.get.bind(redis);
      redis.get = jest.fn(() => { throw new Error('down'); });

      const result = await getCachedDashboard('ws-1', true);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
      redis.get = original;
    });

    it('fails open on Redis write error (swallows, logs warning)', async () => {
      const redis = getRedis();
      const original = redis.set.bind(redis);
      redis.set = jest.fn(() => { throw new Error('down'); });

      await expect(setCachedDashboard('ws-1', true, {})).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
      redis.set = original;
    });
  });

  describe('getCachedOverdueSummary / setCachedOverdueSummary', () => {
    it('round-trips a payload', async () => {
      await setCachedOverdueSummary('ws-1', { overdue_count: 3 });
      expect(await getCachedOverdueSummary('ws-1')).toEqual({ overdue_count: 3 });
    });

    it('fails open on read error', async () => {
      const redis = getRedis();
      const original = redis.get.bind(redis);
      redis.get = jest.fn(() => { throw new Error('down'); });

      expect(await getCachedOverdueSummary('ws-1')).toBeNull();
      redis.get = original;
    });
  });

  describe('invalidateDashboard', () => {
    it('clears both admin and member views plus the overdue summary', async () => {
      await setCachedDashboard('ws-1', true, { a: 1 });
      await setCachedDashboard('ws-1', false, { b: 2 });
      await setCachedOverdueSummary('ws-1', { c: 3 });

      await invalidateDashboard('ws-1');

      expect(await getCachedDashboard('ws-1', true)).toBeNull();
      expect(await getCachedDashboard('ws-1', false)).toBeNull();
      expect(await getCachedOverdueSummary('ws-1')).toBeNull();
    });

    it('no-ops when workspaceId is falsy', async () => {
      await expect(invalidateDashboard(null)).resolves.toBeUndefined();
    });

    it('fails open on Redis error (never throws)', async () => {
      const redis = getRedis();
      const original = redis.del.bind(redis);
      redis.del = jest.fn(() => { throw new Error('down'); });

      await expect(invalidateDashboard('ws-1')).resolves.toBeUndefined();
      redis.del = original;
    });
  });
});
