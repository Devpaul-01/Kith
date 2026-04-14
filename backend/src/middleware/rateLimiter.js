// src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

const createLimiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message } },
    skip: (req) => process.env.NODE_ENV === 'test',
  });

// Auth endpoints: 5/min per IP
const authLimiter = createLimiter(
  60 * 1000,
  5,
  'Too many auth attempts. Try again in a minute.'
);

// Invite acceptance: 10/hour per IP
const inviteLimiter = createLimiter(
  60 * 60 * 1000,
  10,
  'Too many invite attempts. Try again later.'
);

// File upload URL generation: 20/hour per user
const uploadLimiter = createLimiter(
  60 * 60 * 1000,
  20,
  'Upload limit reached. Try again later.'
);

// General API: 200/min per user
const generalLimiter = createLimiter(
  60 * 1000,
  200,
  'Request limit reached. Slow down.'
);

module.exports = { authLimiter, inviteLimiter, uploadLimiter, generalLimiter };
