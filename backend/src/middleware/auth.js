// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { supabaseAdmin } = require('../config/supabase');
const { UnauthorizedError } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Verifies the Supabase JWT and attaches user context to req.
 * req.user = { id, email }
 */


async function requireAuth(req, res, next) {
  const startTime = Date.now();
  const requestId = req.requestId || 'no-req-id';
  
  console.log(`[${requestId}] 🔐 requireAuth called for ${req.method} ${req.path}`);
  logger.debug('requireAuth started', { requestId, method: req.method, path: req.path });
  
  try {
    // Log all headers for debugging (be careful not to log sensitive data in production)
    
    const header = req.headers.authorization;
    
    // Check if header exists
    if (!header) {
      
      logger.warn('Missing Authorization header', { requestId, path: req.path });
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }
    
    // Check if header starts with Bearer
    if (!header.startsWith('Bearer ')) {
      
      logger.warn('Invalid Authorization header format', { requestId, headerPrefix: header.substring(0, 10) });
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }
    
    // Extract token
    const token = header.slice(7);
    
    logger.debug('Token extracted', { requestId, tokenLength: token.length });
    
    // Verify token with Supabase
    
    const verifyStartTime = Date.now();
    
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    const verifyDuration = Date.now() - verifyStartTime;
    
    
    if (error) {
      
      if (error.__proto__) console.log(`[${requestId}]   - Error type: ${error.constructor.name}`);
      
      logger.error('Supabase token verification failed', {
        requestId,
        errorMessage: error.message,
        errorStatus: error.status,
        errorName: error.name,
        tokenPreview: token.substring(0, 20),
      });
      
      throw new UnauthorizedError('Invalid or expired token');
    }
    
    if (!user) {
      
      logger.warn('No user object in Supabase response', { requestId });
      throw new UnauthorizedError('Invalid or expired token');
    }
    
    // Success - user verified
    
    
    logger.info('User authenticated successfully', {
      requestId,
      userId: user.id,
      email: user.email,
      emailConfirmed: !!user.email_confirmed_at,
    });
    
    // Set user from Supabase
    req.user = { 
      id: user.id, 
      email: user.email,
      full_name: user.user_metadata?.full_name,
    };
    
    
    // In auth.js, right after the supabaseAdmin.from(...) call (around line 66)
console.log(`[${requestId}] 🔄 About to call fire-and-forget update`);

supabaseAdmin
  .from('users')
  .update({ last_seen_at: new Date().toISOString() })
  .eq('id', user.id)
  .then(({ error: updateError, data }) => {
    console.log(`[${requestId}] 📞 THEN callback executed`);
    if (updateError) {
      console.log(`[${requestId}] ⚠️ Failed to update last_seen_at: ${updateError.message}`);
      logger.warn('Failed to update last_seen_at', { 
        requestId, 
        userId: user.id, 
        error: updateError.message 
      });
    } else {
      console.log(`[${requestId}] ✅ last_seen_at updated successfully`);
    }
  })
  .catch(err => {
    console.log(`[${requestId}] 💥 CATCH callback executed:`, err.message);
    console.log(`[${requestId}] ⚠️ Error updating last_seen_at:`, err.message);
  });

console.log(`[${requestId}] ✅ Fire-and-forget call initiated (non-blocking)`);

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] ⏱️ requireAuth completed successfully in ${totalDuration}ms`);
    
    next();
  } catch (err) {
    const totalDuration = Date.now() - startTime;
    
    
    logger.error('requireAuth error', {
      requestId,
      errorName: err.name,
      errorMessage: err.message,
      statusCode: err.statusCode,
      stack: err.stack,
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
