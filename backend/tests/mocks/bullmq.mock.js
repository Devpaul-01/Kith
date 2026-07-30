// tests/mocks/bullmq.mock.js
//
// UNIT TESTS ONLY. Integration tests use the real BullMQ against the
// Docker test Redis (Doc 3 Section 5) so that repeatable-job registration,
// worker pickup, and retry/backoff behavior are exercised for real.
//
// This mock replaces queues/index.js's getQueue(name) with a jest.fn()
// based stand-in, letting a unit test assert exactly which queue name +
// job name + payload + options a service called `.add()` with, without
// needing a live Redis connection.
//
// USAGE:
//   jest.mock('../../../src/queues', () => require('../../mocks/bullmq.mock'));
//
//   // in a test:
//   const { __getQueueMockCalls, __mockQueueAdd } = require('../../../tests/mocks/bullmq.mock');
//   await someService.doThingThatEnqueues(...);
//   expect(__mockQueueAdd).toHaveBeenCalledWith(
//     'generate-cycles',
//     expect.objectContaining({ container_id: 'abc' }),
//     expect.objectContaining({ attempts: 3 })
//   );
//
// If a test needs getQueue() to THROW (e.g. simulating "Unknown queue" or
// a Redis-down enqueue failure, exercising the fail-soft `catch` blocks
// in container.service.js#createContainer / #convertToRecurring), use
// `__mockQueueAddOnce.mockRejectedValueOnce(new Error('...'))` before the
// call under test.

const mockQueueAdd = jest.fn(() => Promise.resolve({ id: 'mock-job-id' }));

const mockQueueInstance = {
  add: mockQueueAdd,
  getRepeatableJobs: jest.fn(() => Promise.resolve([])),
  removeRepeatableByKey: jest.fn(() => Promise.resolve()),
  close: jest.fn(() => Promise.resolve()),
};

const getQueue = jest.fn((name) => mockQueueInstance);

const QUEUE_NAMES = [
  'notification-queue',
  'reminder-queue',
  'cycle-generation-queue',
  'cycle-lifecycle-queue',
  'task-overdue-queue',
  'invite-cleanup-queue',
  'engagement-check-queue',
  'notification-outbox-queue',
  'data-export-queue',
];

function getAllQueues() {
  return [mockQueueInstance];
}

async function closeQueues() {
  await mockQueueInstance.close();
}

module.exports = {
  getQueue,
  getAllQueues,
  closeQueues,
  QUEUE_NAMES,
  // Test-only exports for assertions/scripting
  __mockQueueAdd: mockQueueAdd,
  __mockQueueInstance: mockQueueInstance,
  __getQueueMockCalls: () => getQueue.mock.calls,
  __resetBullmqMock: () => {
    getQueue.mockClear();
    mockQueueAdd.mockClear();
  },
};
