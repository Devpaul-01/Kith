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

    it.each([false, true])('keeps workspaces separate for the same role (isAdmin=%s)', async (isAdmin) => {
      await setCachedDashboard('ws-1', isAdmin, { summary: 'first-workspace' });
      expect(await getCachedDashboard('ws-2', isAdmin)).toBeNull();
      await setCachedDashboard('ws-2', isAdmin, { summary: 'second-workspace' });

      expect(await getCachedDashboard('ws-1', isAdmin)).toEqual({ summary: 'first-workspace' });
      expect(await getCachedDashboard('ws-2', isAdmin)).toEqual({ summary: 'second-workspace' });
    });

    it.each(['admin', 'member'])('ignores %s payloads cached before the workspace-isolation fix', async (role) => {
      await getRedis().set(`kith:dashboard:ws-1:${role}`, JSON.stringify({ upcoming_deadlines: ['other-workspace'] }));
      expect(await getCachedDashboard('ws-1', role === 'admin')).toBeNull();
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

    it('keeps overdue summaries separate across workspaces', async () => {
      await setCachedOverdueSummary('ws-1', { overdue_count: 3 });
      expect(await getCachedOverdueSummary('ws-2')).toBeNull();
      await setCachedOverdueSummary('ws-2', { overdue_count: 1 });

      expect(await getCachedOverdueSummary('ws-1')).toEqual({ overdue_count: 3 });
      expect(await getCachedOverdueSummary('ws-2')).toEqual({ overdue_count: 1 });
    });

    it('ignores overdue payloads cached before the workspace-isolation fix', async () => {
      await getRedis().set('kith:overdue-summary:ws-1', JSON.stringify({ overdue: ['other-workspace'] }));
      expect(await getCachedOverdueSummary('ws-1')).toBeNull();
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
      await setCachedDashboard('ws-2', true, { other: 'admin' });
      await setCachedDashboard('ws-2', false, { other: 'member' });
      await setCachedOverdueSummary('ws-2', { overdue_count: 2 });

      await invalidateDashboard('ws-1');

      expect(await getCachedDashboard('ws-1', true)).toBeNull();
      expect(await getCachedDashboard('ws-1', false)).toBeNull();
      expect(await getCachedOverdueSummary('ws-1')).toBeNull();
      expect(await getCachedDashboard('ws-2', true)).toEqual({ other: 'admin' });
      expect(await getCachedDashboard('ws-2', false)).toEqual({ other: 'member' });
      expect(await getCachedOverdueSummary('ws-2')).toEqual({ overdue_count: 2 });
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
