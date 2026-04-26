// src/workers/index.js
require('dotenv').config();
const logger = require('../utils/logger');
const { createNotificationWorker } = require('./notification.worker');
const {
  createReminderWorker,
  createCycleGenerationWorker,
  createCycleLifecycleWorker,
  createTaskOverdueWorker,
  createInviteCleanupWorker,
  createEngagementCheckWorker,
} = require('./background.workers');
const { setupScheduler } = require('../queues/scheduler');

async function startWorkers() {
  logger.info('Starting Kith workers...');

  const workers = [
    createNotificationWorker(),
    createReminderWorker(),
    createCycleGenerationWorker(),
    createCycleLifecycleWorker(),
    createTaskOverdueWorker(),
    createInviteCleanupWorker(),
    createEngagementCheckWorker(),
  ];

  for (const worker of workers) {
    worker.on('completed', (job) => {
      logger.info(`Worker job completed`, { queue: worker.name, jobId: job.id });
    });
    worker.on('failed', (job, err) => {
      logger.error(`Worker job failed`, {
        queue: worker.name,
        jobId: job?.id,
        error: err.message,
        attempts: job?.attemptsMade,
      });
    });
  }

  // Setup scheduler (cron jobs)
  await setupScheduler();

  logger.info('All workers started', { count: workers.length });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startWorkers().catch((err) => {
  logger.error('Failed to start workers', { error: err.message });
  process.exit(1);
});
