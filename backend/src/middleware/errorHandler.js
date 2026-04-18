// src/middleware/errorHandler.js
const { AppError } = require('../utils/errors');
const { ZodError } = require('zod');
const logger = require('../utils/logger');

// errorHandler.js - add this at the VERY TOP of the errorHandler function
function errorHandler(err, req, res, next) {
  // ============================================
  // 🚨 TERMUX / BACKEND CONSOLE LOGGING
  // ============================================
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║           🚨 ERROR HANDLER TRIGGERED              ║');
  console.log('╚════════════════════════════════════════════════════╝');
  
  // Log error type and message
  console.log('📌 Error Type:', err.constructor.name);
  console.log('📌 Error Message:', err.message);
  
  // Log request details
  console.log('📌 Request:', req.method, req.originalUrl);
  console.log('📌 Workspace ID:', req.params?.workspaceId || 'N/A');
  console.log('📌 User ID:', req.user?.id || req.member?.id || 'N/A');
  
  // Log request body (if POST/PUT/PATCH)
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    console.log('📌 Request Body:', JSON.stringify(req.body, null, 2));
  }
  
  // Log stack trace for unexpected errors
  if (!(err instanceof AppError) && !(err instanceof ZodError)) {
    console.log('📌 Stack Trace:\n', err.stack);
  }
  
  console.log('══════════════════════════════════════════════════════\n');
  if (err instanceof ZodError) {
    const firstError = err.errors[0];
    return res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: firstError.message,
        field: firstError.path.join('.'),
        details: err.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
          code: e.code,
        })),
      },
    });
  }

  // Known application errors
  if (err instanceof AppError) {
    const body = {
      error: {
        code: err.code,
        message: err.message,
      },
    };
    if (err.field) body.error.field = err.field;
    if (err.details) body.error.details = err.details;

    if (err.statusCode >= 500) {
      logger.error('Application error', {
        request_id: req.requestId,
        code: err.code,
        message: err.message,
        stack: err.stack,
      });
    }

    return res.status(err.statusCode).json(body);
  }

  // Postgres errors
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with this data already exists.' },
    });
  }
  if (err.code === '23503') {
    return res.status(422).json({
      error: { code: 'BUSINESS_RULE_VIOLATION', message: 'Referenced resource does not exist.' },
    });
  }

  // Unhandled errors
  logger.error('Unhandled error', {
    request_id: req.requestId,
    message: err.message,
    stack: err.stack,
  });

  // Don't leak internal errors in production
  const message =
    process.env.NODE_ENV === 'production' ? 'An internal error occurred' : err.message;

  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}

module.exports = { errorHandler };
