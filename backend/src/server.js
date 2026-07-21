// src/server.js
require('dotenv').config();

// ── Environment validation ─────────────────────────────────────────
// Fail fast with a clear message if required variables are missing.
function validateEnvironment() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'REDIS_URL',
    'FRONTEND_URL',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // Use process.stderr directly — logger may depend on env vars itself
    process.stderr.write(
      `[FATAL] Missing required environment variables: ${missing.join(', ')}\n` +
      `        Set these in your .env file before starting the server.\n`
    );
    process.exit(1);
  }
}

validateEnvironment();

// Sentry must be initialised before anything else
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/node');
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const app    = require('./app');
const logger = require('./utils/logger');
const { checkConnection: checkDb }    = require('./config/database');
const { checkConnection: checkRedis } = require('./config/redis');

const PORT = parseInt(process.env.PORT) || 3000;

async function start() {
  logger.info('Running pre-flight checks...');

  try {
    const dbOk = await checkDb();
    if (!dbOk) throw new Error('Database connection failed');
    logger.info('✓ Database connected');

    const redisOk = await checkRedis();
    if (!redisOk) logger.warn('⚠ Redis not connected — queues disabled');
    else logger.info('✓ Redis connected');
  } catch (err) {
    logger.error('Pre-flight check failed', { error: err.message });
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('Kith API running', {
      port: PORT,
      env:  process.env.NODE_ENV,
      url:  process.env.API_BASE_URL || `http://localhost:${PORT}`,
    });
  });

  // Explicit timeouts instead of relying on Node defaults. keepAliveTimeout
  // must stay LOWER than any upstream load balancer's own idle timeout
  // (e.g. ALB defaults to 60s) to avoid a race where the LB reuses a
  // connection Node has already started closing. headersTimeout must be
  // greater than keepAliveTimeout per Node's own requirement.
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout   = 66 * 1000;

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 s if connections hang
    setTimeout(() => {
      logger.error('Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

start();
