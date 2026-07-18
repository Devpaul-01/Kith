// src/middleware/rateLimiter.js
//
// Issue C3 fix: rate limiting was previously backed by the default in-memory
// store, which is scoped per Node process. The moment this API runs on more
// than one instance (required to serve hundreds/thousands of users behind a
// load balancer), each instance keeps its own independent counters and the
// effective limit becomes `max × instance_count` with zero coordination —
// silently defeating brute-force protection on auth endpoints.
//
// Now backed by the same Redis instance already used for BullMQ, via
// rate-limit-redis. Requires `rate-limit-redis` in package.json:
//     npm install rate-limit-redis
//
// Issue H4 fix: the default express-rate-limit key generator is IP-based,
// even though `generalLimiter` was named/intended as a per-user limit. Now
// keyed by `req.user.id` when available (post-auth routes), falling back to
// IP only for pre-auth routes (signup/login) where no user identity exists
// yet. This also fixes the false-positive case of many legitimate users
// behind the same NAT/corporate IP sharing one bucket.

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

// Build a Redis-backed store with a unique prefix per limiter.
// Falls back to the in-memory default (with a loud warning) if Redis is
// unavailable, so a Redis outage degrades rate limiting rather than
// crashing the whole API.
function buildStore(prefix) {
  try {
    const redis = getRedis();
    if (!redis || typeof redis.call !== 'function') {
      logger.warn(`Rate limiter [${prefix}]: Redis client unavailable or missing .call() — falling back to in-memory store. Rate limits will NOT be shared across instances.`);
      return undefined;
    }
    return new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix,
    });
  } catch (err) {
    logger.warn(`Rate limiter [${prefix}]: failed to initialize Redis store — falling back to in-memory store`, { error: err.message });
    return undefined;
  }
}

// Per-user key when authenticated, per-IP otherwise (pre-auth routes).
const perUserKey = (req) => req.user?.id || req.ip;

// Pre-auth routes (signup/login/forgot-password) have no req.user yet —
// these are intentionally keyed by IP only.
const perIpKey = (req) => req.ip;

const createLimiter = (prefix, windowMs, max, message, { keyGenerator = perUserKey } = {}) =>
  rateLimit({
    windowMs,
    max,
    store: buildStore(prefix),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    message: { error: { code: 'RATE_LIMITED', message } },
    skip: (req) => process.env.NODE_ENV === 'test',
  });

// Auth endpoints: 5 / min per IP (no authenticated identity exists yet)
const authLimiter = createLimiter(
  'rl:auth:',
  60 * 1000,
  5,
  'Too many auth attempts. Try again in a minute.',
  { keyGenerator: perIpKey }
);

// Invite acceptance: 10 / hour per user (requireAuth runs before this in
// the route chain, so req.user is populated) — falls back to IP if not.
const inviteLimiter = createLimiter(
  'rl:invite:',
  60 * 60 * 1000,
  10,
  'Too many invite attempts. Try again later.'
);

// File upload URL generation: 20 / hour per user
const uploadLimiter = createLimiter(
  'rl:upload:',
  60 * 60 * 1000,
  20,
  'Upload limit reached. Try again later.'
);

// General API: 200 / min per user
const generalLimiter = createLimiter(
  'rl:general:',
  60 * 1000,
  200,
  'Request limit reached. Slow down.'
);

module.exports = { authLimiter, inviteLimiter, uploadLimiter, generalLimiter };
