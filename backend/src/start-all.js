// src/start-all.js
//
// Single-process runner for local dev / small deployments: starts the
// HTTP API and all background workers (+ scheduler) together, under one
// `node` process, with one shared graceful-shutdown path.
//
// Redis is treated as OPTIONAL at boot: if it's unreachable, the API
// still starts and serves traffic; workers + the scheduler are simply
// skipped. This prevents a Redis outage (or a free-plan Redis that has
// gone to sleep) from crash-looping the entire process and taking the
// API down with it.
//
// server.js and workers/index.js remain untouched and still work
// standalone (e.g. for running the API and workers as separate
// processes/containers in a real production deployment). This file just
// gives you a single command for local use.
//
// Usage:  node src/start-all.js

require('dotenv').config();

function validateEnvironment() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FRONTEND_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    process.stderr.write(
      `[FATAL] Missing required environment variables: ${missing.join(', ')}\n` +
      `        Set these in your .env file before starting.\n`
    );
    process.exit(1);
  }

  // REDIS_URL is intentionally NOT in the required list. The API can run
  // without it (no background jobs); we warn instead of refusing to boot.
  if (!process.env.REDIS_URL) {
    process.stderr.write(
      `[WARN] REDIS_URL is not set — background workers and the scheduler ` +
      `will be disabled. The HTTP API will still start.\n`
    );
  }
}
validateEnvironment();

if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const app = require('./app');
const logger = require('./utils/logger');
const { checkConnection: checkDb } = require('./config/database');
const { checkConnection: checkRedis } = require('./config/redis');

const PORT = parseInt(process.env.PORT) || 3000;

async function start() {
  logger.info('Running pre-flight checks...');

  // ── Database (required) ─────────────────────────────────────────
  const dbOk = await checkDb();
  if (!dbOk) {
    logger.error('Pre-flight check failed: database connection failed');
    process.exit(1);
  }
  logger.info('✓ Database connected');

  // ── Redis (optional) ────────────────────────────────────────────
  // A Redis failure must NOT kill the API. We probe once; if it's down
  // we skip workers + scheduler entirely and keep serving HTTP.
  let redisOk = false;
  try {
    redisOk = await checkRedis();
  } catch (err) {
    logger.warn('Redis check threw — treating Redis as unavailable', {
      error: err.message,
    });
    redisOk = false;
  }

  if (redisOk) {
    logger.info('✓ Redis connected');
  } else {
    logger.warn('⚠ Redis not connected — background jobs disabled, API will still run');
  }

  // ── HTTP API (always starts) ────────────────────────────────────
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Kith API running', {
      port: PORT,
      env: process.env.NODE_ENV,
      url: process.env.API_BASE_URL || `http://localhost:${PORT}`,
    });
  });
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  // ── Background workers + scheduler (only if Redis is up) ────────
  let workers = [];

  if (redisOk) {
    try {
      const { createNotificationWorker } = require('./workers/notification.worker');
      const {
        createReminderWorker,
        createCycleGenerationWorker,
        createCycleLifecycleWorker,
        createTaskOverdueWorker,
        createInviteCleanupWorker,
        createEngagementCheckWorker,
        createNotificationOutboxWorker,
      } = require('./workers/background.workers');
      const { createDataExportWorker } = require('./workers/data_export.worker');
      const { setupScheduler } = require('./queues/scheduler');

      workers = [
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
        'notification', 'reminder', 'cycleGeneration', 'cycleLifecycle',
        'taskOverdue', 'inviteCleanup', 'engagementCheck', 'dataExport', 'notificationOutbox',
      ];

      workers.forEach((worker, i) => {
        const name = workerNames[i];
        worker.on('completed', (job) => logger.info('Worker job completed', { queue: name, jobId: job.id }));
        worker.on('failed', (job, err) => logger.error('Worker job failed', { queue: name, jobId: job?.id, error: err.message }));
        worker.on('error', (err) => logger.error('Worker error', { queue: name, error: err.message }));
        logger.info('Worker started', { queue: name });
      });

      await setupScheduler();
      logger.info('Scheduler setup complete — API and all workers running in one process');
    } catch (err) {
      // Workers/scheduler failed to come up — log loudly, clean up whatever
      // was partially created, and KEEP THE API RUNNING.
      logger.error('Failed to start workers/scheduler — API continues without background jobs', {
        error: err.message,
        stack: err.stack,
      });

      await Promise.all(
        workers.map((w) => w.close().catch(() => {}))
      );
      workers = [];
    }
  } else {
    logger.warn('Skipping worker + scheduler startup because Redis is unavailable');
  }

  // ── Shared graceful shutdown ─────────────────────────────────────
  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);

    server.close();
    await Promise.race([
      Promise.all(workers.map((w) => w.close().catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // Log but DO NOT exit — a stray rejection (e.g. a Redis blip) must not
    // take the API down.
    logger.error('Unhandled promise rejection', { reason: String(reason?.message || reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    shutdown('uncaughtException').then(() => process.exit(1));
  });
}

start().catch((err) => {
  logger.error('Failed to start', { error: err.message, stack: err.stack });
  process.exit(1);
});
