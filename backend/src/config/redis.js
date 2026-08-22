// src/config/redis.js
const { Redis } = require('ioredis');
const logger = require('../utils/logger');

// Get Redis URL and extract hostname for SNI
const REDIS_URL = process.env.REDIS_URL;
let redisHostname = null;

// Extract hostname from Redis URL for SNI
if (REDIS_URL) {
  try {
    // Parse the URL to get hostname
    const url = new URL(REDIS_URL);
    redisHostname = url.hostname;
  } catch (e) {
    logger.error('Failed to parse REDIS_URL', { error: e.message });
  }
}

const redisOptions = {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  
  // ✅ FIX: TLS configuration for Layerbase
  tls: {
    // SNI: Set servername to the Redis hostname
    servername: redisHostname || undefined,
    // Reject unauthorized is false for self-signed certs (optional)
    rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false,
  },
  
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
};

let redis;

function getRedis() {
  if (!redis) {
    // Check if REDIS_URL exists
    if (!process.env.REDIS_URL) {
      logger.error('REDIS_URL environment variable is not set');
      throw new Error('REDIS_URL is required');
    }

    logger.info('Connecting to Redis with TLS/SNI', { 
      host: redisHostname,
      tlsEnabled: true 
    });

    redis = new Redis(process.env.REDIS_URL, redisOptions);
    
    redis.on('error', (err) => {
      logger.error('Redis error', { error: err.message, stack: err.stack });
    });
    
    redis.on('connect', () => {
      logger.info('Redis connected successfully');
    });
    
    redis.on('ready', () => {
      logger.info('Redis ready');
    });
    
    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });
    
    redis.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });
  }
  return redis;
}

async function checkConnection() {
  try {
    const r = getRedis();
    await r.ping();
    return true;
  } catch (error) {
    logger.error('Redis connection check failed', { error: error.message });
    return false;
  }
}

// Graceful shutdown
async function disconnectRedis() {
  if (redis) {
    try {
      await redis.quit();
      logger.info('Redis disconnected gracefully');
    } catch (error) {
      logger.error('Error disconnecting Redis', { error: error.message });
    }
  }
}

module.exports = { getRedis, checkConnection, disconnectRedis };