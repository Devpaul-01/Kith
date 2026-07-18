// src/middleware/rateLimiter.js
//
// Rate limiting is backed by the shared Redis instance already used for
// BullMQ, via rate-limit-redis, so limits are correctly shared across
// every instance behind the load balancer instead of each instance
// keeping its own independent in-memory counters.
//
// Two distinct limiters cover two distinct threat models:
//
//   generalLimiter   — mounted globally in app.js, BEFORE any auth
//                       middleware runs on any route (including public
//                       ones). req.user is therefore never populated at
//                       the point this limiter's keyGenerator executes,
//                       so it is IP-keyed by design, not by accident.
//                       It exists to give every request — authenticated
//                       or not — a baseline defense-in-depth ceiling.
//
//   userGeneralLimiter — mounted AFTER requireAuth (inside
//                       workspace.routes.js and auth.routes.js's
//                       authenticated section), where req.user.id is
//                       guaranteed to be populated. This is the limiter
//                       that actually delivers per-user throttling —
//                       e.g. many legitimate users behind one shared
//                       corporate/campus NAT no longer share a single
//                       bucket for authenticated, workspace-scoped
//                       traffic, which was the whole point of keying by
//                       user in the first place.
//
// (Previously a single `generalLimiter` claimed to be per-user via
// `req.user?.id || req.ip`, but because it was mounted before auth ran
// anywhere, req.user was always undefined and it silently fell back to
// IP on 100% of traffic — see audit finding 2.3. Splitting into two
// limiters, each correctly scoped to where the identity it needs is
// actually available, fixes this without weakening the pre-auth
// baseline.)

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

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

// Per-user key — only safe to use on limiters mounted AFTER requireAuth.
const perUserKey = (req) => req.user?.id || req.ip;

// Pre-auth / identity-agnostic routes are keyed by IP only.
const perIpKey = (req) => req.ip;

const createLimiter = (prefix, windowMs, max, message, { keyGenerator = perIpKey } = {}) =>
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
  'Too many invite attempts. Try again later.',
  { keyGenerator: perUserKey }
);

// File upload URL generation: 20 / hour per user
const uploadLimiter = createLimiter(
  'rl:upload:',
  60 * 60 * 1000,
  20,
  'Upload limit reached. Try again later.',
  { keyGenerator: perUserKey }
);

// Public, unauthenticated lookup endpoints (invite preview, public
// container view): tighter IP-based limiter tuned specifically against
// token-space enumeration, since generalLimiter's 200/min is too loose
// to be a meaningful anti-enumeration control on its own (audit 8.2).
const publicLookupLimiter = createLimiter(
  'rl:public-lookup:',
  60 * 1000,
  30,
  'Too many requests. Please slow down and try again shortly.',
  { keyGenerator: perIpKey }
);

// General API baseline: 200 / min per IP. Mounted globally, before auth
// resolves — this is intentionally IP-based (see header comment above).
const generalLimiter = createLimiter(
  'rl:general-ip:',
  60 * 1000,
  200,
  'Request limit reached. Slow down.',
  { keyGenerator: perIpKey }
);

// General API, per authenticated user: 200 / min per user. Mount this
// AFTER requireAuth on authenticated route trees (workspace.routes.js,
// auth.routes.js's authenticated section) — this is the limiter that
// actually protects a single heavy user without penalizing everyone else
// behind the same NAT/IP.
const userGeneralLimiter = createLimiter(
  'rl:general-user:',
  60 * 1000,
  200,
  'Request limit reached. Slow down.',
  { keyGenerator: perUserKey }
);

module.exports = {
  authLimiter,
  inviteLimiter,
  uploadLimiter,
  publicLookupLimiter,
  generalLimiter,
  userGeneralLimiter,
};
