// src/middleware/auth.js
const { supabaseAdmin } = require('../config/supabase');
const { getRedis } = require('../config/redis');
const { UnauthorizedError } = require('../utils/errors');
const { TTL, lastSeenKey } = require('../config/redis-keys');
const logger = require('../utils/logger');

// last_seen_at is debounced via a Redis `SET ... NX EX` claim so only the
// request that successfully claims the key across the whole fleet
// performs the write — true single-writer-per-window behavior regardless
// of instance count.
//
// Fails open: if Redis is unavailable, we skip the debounce and just
// don't write last_seen_at for that request rather than blocking auth on
// a non-critical field.
async function shouldUpdateLastSeen(userId) {
  try {
    const redis = getRedis();
    const result = await redis.set(lastSeenKey(userId), '1', 'EX', TTL.LAST_SEEN_DEBOUNCE_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn('last_seen_at Redis debounce check failed — skipping write for this request', { userId, error: err.message });
    return false;
  }
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

    // Debounced, Redis-coordinated last_seen_at write. Still
    // fire-and-forget: never block the request on this write.
    shouldUpdateLastSeen(user.id).then((shouldWrite) => {
      if (!shouldWrite) return;

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
    });

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
 * Uses an explicit column list rather than select('*') since this is a
 * hot-path middleware run on every authenticated request. If a controller
 * needs an additional field, add it here rather than issuing a separate
 * query in the controller.
 */
async function loadDbUser(req, res, next) {
  try {
    if (!req.user) throw new UnauthorizedError();

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
