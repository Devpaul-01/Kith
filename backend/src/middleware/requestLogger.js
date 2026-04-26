// src/middleware/requestLogger.js
const { generateRequestId } = require('../utils/crypto');
const logger = require('../utils/logger');

function requestId(req, res, next) {
  req.requestId = generateRequestId();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.path}`, {
      request_id: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      user_id: req.user?.id,
      workspace_id: req.params?.workspaceId,
      workspace_member_id: req.member?.id,
    });
  });

  next();
}

module.exports = { requestId, requestLogger };
