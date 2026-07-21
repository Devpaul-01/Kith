// src/start-all.js
//
// Single-process runner for local dev / small deployments: starts the
// HTTP API and all background workers (+ scheduler) together, under one
// `node` process, with one shared graceful-shutdown path.
//
// server.js and workers/index.js remain untouched and still work
// standalone (e.g. for running the API and workers as separate
// processes/containers in a real production deployment). This file just
// gives you a single command for local use.
//
// Usage:  node src/start-all.js

require('dotenv').config();

function validateEnvironment() {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REDIS_URL', 'FRONTEND_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    process.stderr.write(
      `[FATAL] Missing required environment variables: ${missing.join(', ')}\n` +
      `        Set these in your .env file before starting.\n`
    );
    process.exit(1);
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

const PORT = parseInt(process.env.PORT) || 3000;

async function start() {
  logger.info('Running pre-flight checks...');

  const dbOk = await checkDb();
  if (!dbOk) {
    logger.error('Pre-flight check failed: database connection failed');
    process.exit(1);
  }
  logger.info('✓ Database connected');

  const redisOk = await checkRedis();
  if (!redisOk) logger.warn('⚠ Redis not connected — queues/workers will not function correctly');
  else logger.info('✓ Redis connected');

  // ── HTTP API ────────────────────────────────────────────────────
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Kith API running', {
      port: PORT,
      env: process.env.NODE_ENV,
      url: process.env.API_BASE_URL || `http://localhost:${PORT}`,
    });
  });
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;

  // ── Background workers ──────────────────────────────────────────
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
