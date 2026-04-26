// src/queues/index.js
const { Queue } = require('bullmq');
const { getRedis } = require('../config/redis');

const queues = {};

const QUEUE_NAMES = [
  'notification-queue',
  'notification-outbox-queue',   // outbox safety-net for external channel deliveries
  'reminder-queue',
  'cycle-generation-queue',
  'cycle-lifecycle-queue',
  'task-overdue-queue',
  'invite-cleanup-queue',
  'engagement-check-queue',
];

function getQueue(name) {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: false,
      },
    });
  }
  return queues[name];
}

function getAllQueues() {
  // Ensure all queues are initialised
  QUEUE_NAMES.forEach(getQueue);
  return Object.values(queues);
}

module.exports = { getQueue, getAllQueues, QUEUE_NAMES };
