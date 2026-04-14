// src/utils/logger.js
const { createLogger, format, transports } = require('winston');

const { combine, timestamp, printf, colorize, json, errors } = format;

const isDev = process.env.NODE_ENV !== 'production';

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, requestId, ...meta }) => {
    const rid = requestId ? ` [${requestId}]` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp}${rid} ${level}: ${message}${extra}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [new transports.Console()],
  exceptionHandlers: [new transports.Console()],
  rejectionHandlers: [new transports.Console()],
});

module.exports = logger;
