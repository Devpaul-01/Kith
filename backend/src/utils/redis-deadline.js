const { AppError } = require('./errors');

// HTTP reads must not inherit BullMQ's unlimited Redis command retries.
async function withRedisDeadline(redis, operation, timeoutMs = 1000) {
  let timer;
  try {
    if (!redis || (redis.status !== undefined && redis.status !== 'ready')) {
      throw new AppError('Redis is unavailable', 503, 'REDIS_UNAVAILABLE');
    }
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new AppError('Redis command timed out', 503, 'REDIS_UNAVAILABLE')), timeoutMs);
    });
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { withRedisDeadline };
