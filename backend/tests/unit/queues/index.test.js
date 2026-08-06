// tests/unit/queues/index.test.js
const mockClose = jest.fn(() => Promise.resolve());
const MockQueueConstructor = jest.fn().mockImplementation((name) => ({
  name,
  close: mockClose,
}));

describe('queues/index', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.doMock('bullmq', () => ({ Queue: MockQueueConstructor }));
    jest.doMock('../../../src/config/redis', () => ({ getRedis: () => ({ mockConnection: true }) }));
  });

  describe('getQueue', () => {
    it('throws for an unknown queue name (prevents typo-based proliferation)', () => {
      const { getQueue } = require('../../../src/queues');
      expect(() => getQueue('not-a-real-queue')).toThrow(/Unknown queue/);
    });

    it('constructs a Queue with the given name and the shared Redis connection', () => {
      const { getQueue } = require('../../../src/queues');
      const q = getQueue('notification-queue');

      expect(MockQueueConstructor).toHaveBeenCalledWith('notification-queue', { connection: { mockConnection: true } });
      expect(q.name).toBe('notification-queue');
    });

    it('returns the SAME instance on repeated calls (lazy singleton caching)', () => {
      const { getQueue } = require('../../../src/queues');
      const q1 = getQueue('reminder-queue');
      const q2 = getQueue('reminder-queue');

      expect(q1).toBe(q2);
      expect(MockQueueConstructor).toHaveBeenCalledTimes(1);
    });

    it('accepts every name declared in QUEUE_NAMES', () => {
      const { getQueue, QUEUE_NAMES } = require('../../../src/queues');
      QUEUE_NAMES.forEach((name) => {
        expect(() => getQueue(name)).not.toThrow();
      });
    });
  });

  describe('getAllQueues', () => {
    it('BUG: Object.values(Map) always returns [] — getAllQueues() never returns constructed queues', () => {
      // FINDING (verified independently, not a test mistake):
      // src/queues/index.js implements getAllQueues() as:
      //   function getAllQueues() {
      //     QUEUE_NAMES.forEach(getQueue);
      //     return Object.values(queues);
      //   }
      // `queues` is a `Map`, not a plain object. `Object.values()` only
      // operates on own enumerable string-keyed properties of a plain
      // object — a Map instance has none (its entries live in internal
      // slots), so Object.values(aMap) is ALWAYS [] regardless of how
      // many entries the Map holds. Confirmed directly:
      //   const m = new Map([['a',1]]); Object.values(m) // => []
      // Impact: app.js's Bull Board wiring does
      //   queues: getAllQueues().map((q) => new BullMQAdapter(q))
      // which means the admin queue-monitoring dashboard at
      // /admin/queues ALWAYS shows zero queues, even though every
      // queue is correctly constructed and functional via getQueue().
      // Fix: `return [...queues.values()];` (or `Array.from(queues.values())`).
      // This test intentionally asserts the CORRECT behavior, so it
      // fails against the current source and passes once fixed.
      const { getAllQueues, QUEUE_NAMES } = require('../../../src/queues');
      const all = getAllQueues();

      expect(all).toHaveLength(QUEUE_NAMES.length);
    });
  });

  describe('closeQueues', () => {
    it('closes every constructed queue and clears the internal cache (re-construction proven via getQueue call count)', async () => {
      const { getQueue, closeQueues } = require('../../../src/queues');
      getQueue('notification-queue');
      getQueue('reminder-queue');
      expect(MockQueueConstructor).toHaveBeenCalledTimes(2);

      await closeQueues();

      expect(mockClose).toHaveBeenCalledTimes(2);

      // Cache cleared: calling getQueue again for the same name must
      // construct a NEW Queue instance rather than returning a stale one.
      getQueue('notification-queue');
      expect(MockQueueConstructor).toHaveBeenCalledTimes(3);
    });

    it('swallows individual close() failures without throwing', async () => {
      const { getQueue, closeQueues } = require('../../../src/queues');
      getQueue('notification-queue');
      mockClose.mockRejectedValueOnce(new Error('close failed'));

      await expect(closeQueues()).resolves.toBeUndefined();
    });
  });
});
