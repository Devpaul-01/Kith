// src/queues/index.js
//
// Central BullMQ queue registry.
// Queues are created lazily on first access and cached so the same
// Queue instance is reused across the process lifetime.

const { Queue } = require('bullmq');
const { getRedis } = require('../config/redis');

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

/** @type {Map<string, import('bullmq').Queue>} */
const queues = new Map();

/**
 * Returns a shared Queue instance for the given name.
 * Throws if the name is not in QUEUE_NAMES to prevent typo-based
 * queue proliferation.
 *
 * @param {string} name
 * @returns {import('bullmq').Queue}
 */
function getQueue(name) {
  if (!QUEUE_NAMES.includes(name)) {
    throw new Error(`Unknown queue: "${name}". Add it to QUEUE_NAMES in src/queues/index.js`);
  }

  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: getRedis() }));
  }

  return queues.get(name);
}
// queues/index.js
function getAllQueues() {
  QUEUE_NAMES.forEach(getQueue);
  return [...queues.values()]; // ✅ Returns all queue instances
}
/**
 * Gracefully closes all open queue connections.
 * Call during process shutdown after workers have been closed.
 */
async function closeQueues() {
  const closeAll = [...queues.values()].map((q) => q.close().catch(() => {}));
  await Promise.all(closeAll);
  queues.clear();
}

module.exports = { getQueue, getAllQueues, closeQueues, QUEUE_NAMES };
