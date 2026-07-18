// src/workers/background.workers.js
//
// Service-layer refactor: all business logic (DB reads/writes,
// notification orchestration, cycle math, carry-forward, batching) has
// moved into per-concern services (services/reminder.service.js,
// services/cycle_generation.service.js, services/cycle_lifecycle.service.js,
// services/task_overdue.service.js, services/invite_cleanup.service.js,
// services/engagement_check.service.js, services/notification_outbox.service.js).
// This file now only wires each BullMQ Worker to its matching service
// call — job pulled → service invoked → done. No behavior changed.

const { Worker }   = require('bullmq');
const { getRedis } = require('../config/redis');

const { runReminderScan }          = require('../services/reminder.service');
const { generateCycles }           = require('../services/cycle_generation.service');
const { runCycleLifecycle }        = require('../services/cycle_lifecycle.service');
const { runTaskOverdueCheck }      = require('../services/task_overdue.service');
const { runInviteCleanup }         = require('../services/invite_cleanup.service');
const { runEngagementCheck }       = require('../services/engagement_check.service');
const { runNotificationOutboxScan } = require('../services/notification_outbox.service');

function createReminderWorker() {
  return new Worker(
    'reminder-queue',
    async () => runReminderScan(),
    { connection: getRedis(), concurrency: 1 }
  );
}

function createCycleGenerationWorker() {
  return new Worker(
    'cycle-generation-queue',
    async (job) => generateCycles(job.data),
    { connection: getRedis(), concurrency: 5 }
  );
}

function createCycleLifecycleWorker() {
  return new Worker(
    'cycle-lifecycle-queue',
    async () => runCycleLifecycle(),
    { connection: getRedis(), concurrency: 1 }
  );
}

function createTaskOverdueWorker() {
  return new Worker(
    'task-overdue-queue',
    async () => runTaskOverdueCheck(),
    { connection: getRedis(), concurrency: 1 }
  );
}

function createInviteCleanupWorker() {
  return new Worker(
    'invite-cleanup-queue',
    async () => runInviteCleanup(),
    { connection: getRedis(), concurrency: 1 }
  );
}

function createEngagementCheckWorker() {
  return new Worker(
    'engagement-check-queue',
    async () => runEngagementCheck(),
    { connection: getRedis(), concurrency: 1 }
  );
}

function createNotificationOutboxWorker() {
  return new Worker(
    'notification-outbox-queue',
    async () => runNotificationOutboxScan(),
    { connection: getRedis(), concurrency: 1 }
  );
}

module.exports = {
  createReminderWorker,
  createCycleGenerationWorker,
  createCycleLifecycleWorker,
  createTaskOverdueWorker,
  createInviteCleanupWorker,
  createEngagementCheckWorker,
  createNotificationOutboxWorker,
};
