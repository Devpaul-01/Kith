// src/queues/scheduler.js
//
// HOW THIS WORKS
// ──────────────
// BullMQ repeatable jobs live inside the queue they are added to.
// When a cron fires, BullMQ enqueues a job INTO THAT SAME QUEUE.
// A Worker listening on that queue then picks it up.
//
// WRONG (old):  scheduler adds 'reminder-scan' → 'kith-scheduler' queue
//               ReminderWorker listens to      → 'reminder-queue'
//               Result: job fires, nobody processes it. ❌
//
// CORRECT (now): scheduler adds 'reminder-scan' → 'reminder-queue'
//                ReminderWorker listens to       → 'reminder-queue'
//                Result: cron fires, worker processes it. ✅
//
// Each queue owns its own repeatable schedule. We just need one
// Queue instance per target queue to register the cron, then the
// workers that already listen to those queues handle execution.

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
];

async function setupScheduler() {
  const connection = getRedis();
  const registeredQueues = [];

  for (const { jobName, queueName, cron, data } of SCHEDULED_JOBS) {
    const queue = new Queue(queueName, { connection });

    // Remove any existing repeatable job with this name in this queue
    // so restarts don't accumulate duplicate schedules.
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === jobName) {
        await queue.removeRepeatableByKey(job.key);
        logger.info(`Removed stale repeatable job`, { jobName, queueName });
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
    logger.info(`Scheduled job registered`, { jobName, queueName, cron });
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
      // Keep process alive — BullMQ needs an open Redis connection
      // to maintain the repeatable job keys.
      // In production, the worker process calls setupScheduler() instead,
      // so you don't need this process running separately.
    })
    .catch((err) => {
      logger.error('Scheduler failed', { error: err.message });
      process.exit(1);
    });
}

module.exports = { setupScheduler };
