// tests/unit/services/membership-cache.service.test.js
jest.mock('../../../src/config/redis', () => require('../../mocks/redis.mock'));
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../../../src/utils/logger');
const { getRedis, __resetRedisMock } = require('../../mocks/redis.mock');
const {
  getCachedMembership,
  setCachedMembership,
  invalidateMembership,
  invalidateWorkspace,
} = require('../../../src/services/membership-cache.service');

describe('services/membership-cache.service', () => {
  beforeEach(() => {
    __resetRedisMock();
    jest.clearAllMocks();
  });

  describe('getCachedMembership / setCachedMembership round-trip', () => {
    it('returns null for a cache miss', async () => {
      const result = await getCachedMembership('ws-1', 'user-1');
      expect(result).toBeNull();
    });

    it('round-trips a previously-set payload', async () => {
      const payload = { member: { id: 'm1', role: 'admin' }, workspace: { id: 'ws-1', name: 'X' } };
      await setCachedMembership('ws-1', 'user-1', payload);

      const result = await getCachedMembership('ws-1', 'user-1');
      expect(result).toEqual(payload);
    });

    it('does not leak one user/workspace pair\'s cache into another', async () => {
      await setCachedMembership('ws-1', 'user-1', { member: { id: 'm1' } });
      const other = await getCachedMembership('ws-1', 'user-2');
      expect(other).toBeNull();
    });
  });

  describe('Redis failure — fails open', () => {
    it('getCachedMembership returns null and logs a warning when Redis throws', async () => {
      const redis = getRedis();
      const originalGet = redis.get.bind(redis);
      redis.get = jest.fn(() => { throw new Error('Redis down'); });

      const result = await getCachedMembership('ws-1', 'user-1');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Membership cache read failed — falling back to DB',
        expect.objectContaining({ workspaceId: 'ws-1', userId: 'user-1' })
      );

      redis.get = originalGet;
    });

    it('setCachedMembership swallows the error and logs a warning when Redis throws', async () => {
      const redis = getRedis();
      const originalSet = redis.set.bind(redis);
      redis.set = jest.fn(() => { throw new Error('Redis down'); });

      await expect(setCachedMembership('ws-1', 'user-1', {})).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Membership cache write failed',
        expect.objectContaining({ workspaceId: 'ws-1', userId: 'user-1' })
      );

      redis.set = originalSet;
    });
  });

  describe('invalidateMembership', () => {
    it('deletes exactly the one cached entry; a subsequent read returns null', async () => {
      await setCachedMembership('ws-1', 'user-1', { member: {} });
      await invalidateMembership('ws-1', 'user-1');

      expect(await getCachedMembership('ws-1', 'user-1')).toBeNull();
    });

    it('no-ops silently when workspaceId or userId is missing', async () => {
      await expect(invalidateMembership(null, 'user-1')).resolves.toBeUndefined();
      await expect(invalidateMembership('ws-1', null)).resolves.toBeUndefined();
    });
  });

  describe('invalidateWorkspace', () => {
    it('invalidates every cached membership for the workspace, leaving unrelated workspaces untouched', async () => {
      await setCachedMembership('ws-1', 'user-1', { member: {} });
      await setCachedMembership('ws-1', 'user-2', { member: {} });
      await setCachedMembership('ws-1', 'user-3', { member: {} });
      await setCachedMembership('ws-OTHER', 'user-1', { member: {} });

      await invalidateWorkspace('ws-1');

      expect(await getCachedMembership('ws-1', 'user-1')).toBeNull();
      expect(await getCachedMembership('ws-1', 'user-2')).toBeNull();
      expect(await getCachedMembership('ws-1', 'user-3')).toBeNull();
      expect(await getCachedMembership('ws-OTHER', 'user-1')).not.toBeNull();
    });

    it('exercises the SCAN cursor loop with a moderate key count (sequential writes for ioredis-mock stability)', async () => {
      // NOTE: tests/mocks/redis.mock.js documents that ioredis-mock's
      // SCAN implementation has known edge-case gaps versus real Redis,
      // particularly under concurrent/parallel writes. Writing
      // sequentially here (not via Promise.all) keeps this test
      // reliable against the mock while still exercising the do/while
      // cursor loop with more keys than a single COUNT batch. The
      // large-scale, concurrent-write version of this test belongs in
      // Doc 3's integration suite against real Redis, per the mock
      // file's own header comment.
      for (let i = 0; i < 25; i++) {
        // eslint-disable-next-line no-await-in-loop
        await setCachedMembership('ws-big', `user-${i}`, { member: { id: i } });
      }

      await invalidateWorkspace('ws-big');

      for (let i = 0; i < 25; i++) {
        // eslint-disable-next-line no-await-in-loop
        expect(await getCachedMembership('ws-big', `user-${i}`)).toBeNull();
      }
    });

    it('never throws when Redis fails mid-scan (fails open with a warning)', async () => {
      const redis = getRedis();
      const originalScan = redis.scan.bind(redis);
      redis.scan = jest.fn(() => { throw new Error('scan failed'); });

      await expect(invalidateWorkspace('ws-1')).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Workspace-wide membership cache invalidation failed',
        expect.objectContaining({ workspaceId: 'ws-1' })
      );

      redis.scan = originalScan;
    });
  });
});
