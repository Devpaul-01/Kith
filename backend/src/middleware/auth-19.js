// src/middleware/auth.js
const { supabaseAdmin } = require('../config/supabase');
const { UnauthorizedError } = require('../utils/errors');
const logger = require('../utils/logger');

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

    // Fire-and-forget: update last_seen_at without blocking the request
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
 * Loads the full users row and attaches to req.dbUser.
 * Must be called after requireAuth.
 */
async function loadDbUser(req, res, next) {
  try {
    if (!req.user) throw new UnauthorizedError();

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
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
