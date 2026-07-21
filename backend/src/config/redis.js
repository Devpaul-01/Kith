// src/config/redis.js
const { Redis } = require('ioredis');
const logger = require('../utils/logger');

const redisOptions = {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
};

let redis;

function getRedis() {

  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, redisOptions);
    redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
    redis.on('connect', () => logger.info('Redis connected'));
  }
  return redis;
}

async function checkConnection() {
  try {
    const r = getRedis();
    await r.ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getRedis, checkConnection };
