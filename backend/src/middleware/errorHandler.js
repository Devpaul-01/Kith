// src/middleware/errorHandler.js
const { AppError } = require('../utils/errors');
const { ZodError }  = require('zod');
const logger        = require('../utils/logger');

function errorHandler(err, req, res, next) {
  // Body parsing runs before the routers. Never echo malformed JSON or
  // log parser messages/stacks, which can contain private request text.
  if (err.type === 'entity.parse.failed' && err.status === 400) {
    return res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Request body must contain valid JSON.' },
    });
  }
  if (err.type === 'entity.too.large' && err.status === 413) {
    return res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
    });
  }

  // Zod validation errors
  if (err instanceof ZodError) {
    const firstError = err.errors[0];
    return res.status(400).json({
      error: {
        code:    'VALIDATION_FAILED',
        message: firstError.message,
        field:   firstError.path.join('.'),
        details: err.errors.map((e) => ({
          field:   e.path.join('.'),
          message: e.message,
          code:    e.code,
        })),
      },
    });
  }

  // Known application errors
  if (err instanceof AppError) {
    const body = {
      error: {
        code:    err.code,
        message: err.message,
      },
    };
    if (err.field)   body.error.field   = err.field;
    if (err.details) body.error.details = err.details;

    if (err.statusCode >= 500) {
      logger.error('Application error', {
        request_id: req.requestId,
        code:       err.code,
        message:    err.message,
        stack:      err.stack,
      });
    }

    return res.status(err.statusCode).json(body);
  }

  // Postgres unique-violation
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with this data already exists.' },
    });
  }

  // Postgres foreign-key violation
  if (err.code === '23503') {
    return res.status(422).json({
      error: { code: 'BUSINESS_RULE_VIOLATION', message: 'Referenced resource does not exist.' },
    });
  }

  // Unhandled / unexpected errors
  logger.error('Unhandled error', {
    request_id: req.requestId,
    message:    err.message,
    stack:      err.stack,
  });

  const message =
    process.env.NODE_ENV === 'production' ? 'An internal error occurred' : err.message;

  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message },
  });
}

module.exports = { errorHandler };
