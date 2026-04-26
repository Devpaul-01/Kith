// src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Wire a Redis store so rate limits are shared across all server processes.
// Falls back to the default in-memory store if rate-limit-redis is not yet
// installed (npm install rate-limit-redis) or if Redis is unavailable.
//
// IMPORTANT: In-memory fallback means limits are NOT shared across processes.
// Install rate-limit-redis and ensure REDIS_URL is set before deploying.
let RedisStore;
try {
  ({ RedisStore } = require('rate-limit-redis'));
} catch (_) {
  const logger = require('../utils/logger');
  logger.warn('rate-limit-redis not installed — rate limiters will use in-memory store (not shared across processes)');
}

function buildStore() {
  if (!RedisStore) return undefined; // express-rate-limit default (memory)
  try {
    const { getRedis } = require('../config/redis');
    return new RedisStore({
      // BullMQ uses ioredis; rate-limit-redis needs sendCommand
      sendCommand: (...args) => getRedis().sendCommand(args),
    });
  } catch (err) {
    const logger = require('../utils/logger');
    logger.warn('Failed to create Redis rate-limit store — falling back to memory', { error: err.message });
    return undefined;
  }
}

const store = buildStore();

const createLimiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    store,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: { code: 'RATE_LIMITED', message } },
    skip: (req) => process.env.NODE_ENV === 'test',
  });

// Auth endpoints: 5 / min per IP
const authLimiter = createLimiter(
  60 * 1000,
  5,
  'Too many auth attempts. Try again in a minute.'
);

// Invite acceptance: 10 / hour per IP
const inviteLimiter = createLimiter(
  60 * 60 * 1000,
  10,
  'Too many invite attempts. Try again later.'
);

// File upload URL generation: 20 / hour per user
const uploadLimiter = createLimiter(
  60 * 60 * 1000,
  20,
  'Upload limit reached. Try again later.'
);

// General API: 200 / min per user
const generalLimiter = createLimiter(
  60 * 1000,
  200,
  'Request limit reached. Slow down.'
);

module.exports = { authLimiter, inviteLimiter, uploadLimiter, generalLimiter };
