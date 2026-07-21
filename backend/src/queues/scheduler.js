// src/queues/scheduler.js
//
// HOW THIS WORKS
// ──────────────
// BullMQ repeatable jobs live inside the queue they are added to.
// When a cron fires, BullMQ enqueues a job INTO THAT SAME QUEUE.
// A Worker listening on that queue then picks it up.
//
// Each queue owns its own repeatable schedule — one Queue instance per
// target queue registers the cron, and the worker that already listens
// to that queue handles execution.

require('dotenv').config();
const { Queue } = require('bullmq');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

// Map of: job name → { queue: target queue name, cron: cron expression, data: job payload }
const SCHEDULED_JOBS = [
  {
    jobName:   'reminder-scan',
    queueName: 'reminder-queue',
    cron:      '0 7 * * *',      // Daily 07:00 UTC
    data:      {},
  },
  {
    jobName:   'cycle-lifecycle',
    queueName: 'cycle-lifecycle-queue',
    cron:      '1 0 * * *',      // Daily 00:01 UTC
    data:      {},
  },
  {
    jobName:   'task-overdue-check',
    queueName: 'task-overdue-queue',
    cron:      '0 6 * * *',      // Daily 06:00 UTC
    data:      {},
  },
  {
    jobName:   'invite-cleanup',
    queueName: 'invite-cleanup-queue',
    cron:      '0 2 * * *',      // Daily 02:00 UTC
    data:      {},
  },
  {
    jobName:   'engagement-check',
    queueName: 'engagement-check-queue',
    cron:      '0 6 * * 0',      // Weekly Sunday 06:00 UTC
    data:      {},
  },
  {
    jobName:   'cycle-gen-maintenance',
    queueName: 'cycle-generation-queue',
    cron:      '0 3 * * *',      // Daily 03:00 UTC
    data:      { generate_months_ahead: 3 },
  },
  {
    // Notification outbox: re-enqueues any external-channel deliveries
    // stuck in 'pending' or 'failed' for more than 5 minutes.
    // Provides a safety net for queue.add failures in notification_service.js.
    jobName:   'notification-outbox-scan',
    queueName: 'notification-outbox-queue',
    cron:      '*/5 * * * *',    // Every 5 minutes
    data:      {},
  },
];

async function setupScheduler() {
  const connection      = getRedis();
  const registeredQueues = [];

  for (const { jobName, queueName, cron, data } of SCHEDULED_JOBS) {
    const queue = new Queue(queueName, { connection });

    // Remove any existing repeatable job with this name in this queue
    // so restarts don't accumulate duplicate schedules.
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === jobName) {
        await queue.removeRepeatableByKey(job.key);
        logger.info('Removed stale repeatable job', { jobName, queueName });
      }
    }

    // Register the repeatable job directly into the target queue.
    // When the cron fires, BullMQ creates a real job in THIS queue,
    // which the worker for this queue will pick up and execute.
    await queue.add(jobName, data, {
      repeat: { cron },
      jobId: `scheduled:${jobName}`, // stable ID prevents duplicates
    });

    registeredQueues.push(queue);
    logger.info('Scheduled job registered', { jobName, queueName, cron });
  }

  logger.info('Scheduler setup complete — all jobs registered in their target queues', {
    schedule: SCHEDULED_JOBS.map((j) => ({
      job:   j.jobName,
      queue: j.queueName,
      cron:  j.cron,
    })),
  });

  return registeredQueues;
}

// Run standalone: node src/queues/scheduler.js
if (require.main === module) {
  setupScheduler()
    .then(() => {
      logger.info('Scheduler registration complete. Queues are live.');
    })
    .catch((err) => {
      logger.error('Scheduler failed', { error: err.message });
      process.exit(1);
    });
}

module.exports = { setupScheduler };
