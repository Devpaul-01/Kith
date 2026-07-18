// src/workers/index.js
//
// Worker process entry point.

const path = require('path');
require('dotenv').config();

// This check must use console.error, not the structured logger — the
// logger module itself may depend on env vars that haven't been validated
// yet, so we can't assume it's safe to load before this point.
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REDIS_URL'];
const missingEnvVars  = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('   Current working directory:', process.cwd());
  console.error('   Expected .env file location:', path.join(__dirname, '../../.env'));

  const fs      = require('fs');
  const envPath = path.join(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    console.error('   .env file exists at:', envPath);
    console.error('   But missing these variables. Check your .env file.');
  } else {
    console.error('   .env file NOT found at:', envPath);
  }
  process.exit(1);
}

const logger = require('../utils/logger');

const workerStartups = [];

// ── Notification worker ────────────────────────────────────────────
let createNotificationWorker;
try {
  const notificationModule  = require('./notification.worker');
  createNotificationWorker  = notificationModule.createNotificationWorker;
  workerStartups.push('notification');
} catch (err) {
  logger.error('Failed to load notification worker', { error: err.message });
  process.exit(1);
}

// ── Background workers ─────────────────────────────────────────────
//
// createNotificationOutboxWorker is exported by background.workers.js and
// has a cron schedule registered in queues/scheduler.js
// ('notification-outbox-scan', every 5 minutes, targeting
// 'notification-outbox-queue') — it must be instantiated and added to the
// `workers` array below or the outbox safety-net job fires into its queue
// on schedule with nothing listening on it.
let createReminderWorker, createCycleGenerationWorker, createCycleLifecycleWorker,
    createTaskOverdueWorker, createInviteCleanupWorker, createEngagementCheckWorker,
    createNotificationOutboxWorker;

try {
  const bg = require('./background.workers');
  createReminderWorker           = bg.createReminderWorker;
  createCycleGenerationWorker    = bg.createCycleGenerationWorker;
  createCycleLifecycleWorker     = bg.createCycleLifecycleWorker;
  createTaskOverdueWorker        = bg.createTaskOverdueWorker;
  createInviteCleanupWorker      = bg.createInviteCleanupWorker;
  createEngagementCheckWorker    = bg.createEngagementCheckWorker;
  createNotificationOutboxWorker = bg.createNotificationOutboxWorker;
  workerStartups.push('background');
} catch (err) {
  logger.error('Failed to load background workers', { error: err.message });
  process.exit(1);
}

// ── Data export worker ───────────────────────────────────────────────
let createDataExportWorker;
try {
  const exportModule     = require('./data_export.worker');
  createDataExportWorker = exportModule.createDataExportWorker;
  workerStartups.push('dataExport');
} catch (err) {
  logger.error('Failed to load data export worker', { error: err.message });
  process.exit(1);
}

// ── Scheduler ──────────────────────────────────────────────────────
let setupScheduler;
try {
  const schedulerModule = require('../queues/scheduler');
  setupScheduler        = schedulerModule.setupScheduler;
  workerStartups.push('scheduler');
} catch (err) {
  logger.error('Failed to load scheduler', { error: err.message });
  process.exit(1);
}

async function startWorkers() {
  logger.info('Starting Kith workers...', { workers: workerStartups });

  const workers = [
    createNotificationWorker(),
    createReminderWorker(),
    createCycleGenerationWorker(),
    createCycleLifecycleWorker(),
    createTaskOverdueWorker(),
    createInviteCleanupWorker(),
    createEngagementCheckWorker(),
    createDataExportWorker(),
    createNotificationOutboxWorker(),
  ];

  const workerNames = [
    'notification',
    'reminder',
    'cycleGeneration',
    'cycleLifecycle',
    'taskOverdue',
    'inviteCleanup',
    'engagementCheck',
    'dataExport',
    'notificationOutbox',
  ];

  let failedWorkers = 0;
  for (let i = 0; i < workers.length; i++) {
    if (!workers[i]) {
      logger.error(`Worker at index ${i} (${workerNames[i]}) failed to initialize`);
      failedWorkers++;
    }
  }

  if (failedWorkers > 0) {
    logger.error(`Failed to initialize ${failedWorkers} workers`);
    process.exit(1);
  }

  for (let i = 0; i < workers.length; i++) {
    const worker     = workers[i];
    const workerName = workerNames[i];

    if (worker) {
      worker.on('completed', (job) => {
        logger.info('Worker job completed', { queue: workerName, jobId: job.id, workerName: worker.name });
      });

      worker.on('failed', (job, err) => {
        logger.error('Worker job failed', { queue: workerName, jobId: job?.id, error: err.message, attempts: job?.attemptsMade, stack: err.stack });
      });

      worker.on('error', (err) => {
        logger.error('Worker encountered an error', { queue: workerName, error: err.message, stack: err.stack });
      });

      worker.on('stalled', (jobId) => {
        logger.warn('Worker job stalled', { queue: workerName, jobId });
      });

      logger.info('Worker started', { queue: workerName });
    }
  }

  try {
    await setupScheduler();
    logger.info('Scheduler setup complete');
  } catch (err) {
    logger.error('Failed to setup scheduler', { error: err.message, stack: err.stack });
    process.exit(1);
  }

  logger.info('All workers started successfully', {
    count:   workers.filter((w) => w).length,
    workers: workerNames,
  });

  // ── Graceful shutdown ────────────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down workers...`);

    const closePromises = workers.map(async (worker, idx) => {
      if (worker) {
        try {
          await worker.close();
          logger.info(`Worker ${workerNames[idx]} closed`);
        } catch (err) {
          logger.error(`Error closing worker ${workerNames[idx]}`, { error: err.message });
        }
      }
    });

    await Promise.race([
      Promise.all(closePromises),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);

    logger.info('All workers shut down');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception in worker process', { error: err.message, stack: err.stack });
    shutdown('uncaughtException').then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in worker process', { reason: reason?.message || reason });
  });
}

startWorkers().catch((err) => {
  logger.error('Failed to start workers', { error: err.message, stack: err.stack });
  process.exit(1);
});
