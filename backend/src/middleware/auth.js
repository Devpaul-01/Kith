// src/middleware/auth.js
const { supabaseAdmin } = require('../config/supabase');
const { UnauthorizedError } = require('../utils/errors');
const logger = require('../utils/logger');

// Issue H7 fix: requireAuth previously fired a fire-and-forget
// `UPDATE users SET last_seen_at = now()` on every single authenticated
// API call, unconditionally, across the entire application — a user
// making 50 calls in a session triggered 50 writes for a field that only
// needs minute-level granularity. At "hundreds to thousands of users"
// scale this becomes a meaningful, entirely avoidable share of total
// write load, competing with real business writes for connection pool
// capacity.
//
// Now debounced: last_seen_at is only written if it's stale by more than
// LAST_SEEN_STALE_MS. This is an in-memory, per-process cache — on a
// multi-instance deployment each instance will independently allow one
// write per user per window (so worst case is `instance_count` writes per
// window instead of 1), which is still a large reduction from "every
// request" and requires no additional infrastructure (Redis, etc.) to be
// correct enough for this purpose. If tighter cross-instance coordination
// is ever needed, this cache can be swapped for a Redis-backed TTL check
// using the same getRedis() connection already used elsewhere.

const LAST_SEEN_STALE_MS = 5 * 60 * 1000; // 5 minutes
const lastSeenCache = new Map(); // userId -> last write timestamp (ms)

function shouldUpdateLastSeen(userId) {
  const now = Date.now();
  const lastWrite = lastSeenCache.get(userId);
  if (lastWrite && (now - lastWrite) < LAST_SEEN_STALE_MS) return false;
  lastSeenCache.set(userId, now);
  return true;
}

// Basic unbounded-growth guard: if the process runs long enough to
// accumulate a very large number of distinct users in memory, drop the
// oldest half. This is a cheap safety net, not a precise LRU.
function pruneLastSeenCacheIfNeeded() {
  if (lastSeenCache.size <= 50000) return;
  const entries = [...lastSeenCache.entries()].sort((a, b) => a[1] - b[1]);
  const toDrop = entries.slice(0, Math.floor(entries.length / 2));
  for (const [userId] of toDrop) lastSeenCache.delete(userId);
}

/**
 * Verifies the Supabase JWT and attaches user context to req.
 * req.user = { id, email, full_name }
 */
async function requireAuth(req, res, next) {
  const requestId = req.requestId || 'no-req-id';

  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      logger.warn('Missing or malformed Authorization header', { requestId, path: req.path });
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = header.slice(7);

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error) {
      logger.warn('Supabase token verification failed', {
        requestId,
        errorMessage: error.message,
        errorStatus: error.status,
      });
      throw new UnauthorizedError('Invalid or expired token');
    }

    if (!user) {
      logger.warn('No user object in Supabase response', { requestId });
      throw new UnauthorizedError('Invalid or expired token');
    }

    logger.debug('User authenticated', { requestId, userId: user.id });

    req.user = {
      id:        user.id,
      email:     user.email,
      full_name: user.user_metadata?.full_name,
    };

    // Issue H7 fix: only write last_seen_at if it's actually stale.
    if (shouldUpdateLastSeen(user.id)) {
      pruneLastSeenCacheIfNeeded();

      // Still fire-and-forget: never block the request on this write.
      supabaseAdmin
        .from('users')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', user.id)
        .then(({ error: updateError }) => {
          if (updateError) {
            logger.warn('Failed to update last_seen_at', { requestId, userId: user.id, error: updateError.message });
          }
        })
        .catch((err) => {
          logger.warn('Error updating last_seen_at', { requestId, userId: user.id, error: err.message });
        });
    }

    next();
  } catch (err) {
    logger.error('requireAuth error', {
      requestId,
      errorName:    err.name,
      errorMessage: err.message,
      statusCode:   err.statusCode,
    });
    next(err);
  }
}

/**
 * Loads a targeted set of user columns and attaches to req.dbUser.
 * Must be called after requireAuth.
 *
 * Issue 6 fix: replaced select('*') with an explicit column list so this
 * hot-path middleware does not over-fetch on every authenticated request.
 * If any controller needs additional fields, add them here rather than
 * issuing a separate query in the controller.
 */
async function loadDbUser(req, res, next) {
  try {
    if (!req.user) throw new UnauthorizedError();

    // Issue 6: explicit column list instead of select('*')
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, avatar_url, timezone, preferred_language, push_enabled, email_digest_enabled, deleted_at')
      .eq('id', req.user.id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      throw new UnauthorizedError('User profile not found. Please complete registration.');
    }

    req.dbUser = data;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, loadDbUser };
