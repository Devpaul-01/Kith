const { MemoryStore } = require('express-rate-limit');
const logger = require('../utils/logger');

/** Keep local counters warm so an outage cannot reset this process's limits. */
class ResilientRateLimitStore {
  constructor(remote, prefix) {
    this.remote = remote;
    this.prefix = prefix;
    this.local = new MemoryStore();
    this.localKeys = false;
  }

  init(options) {
    this.remote.init(options);
    this.local.init(options);
  }

  async increment(key) {
    const local = await this.local.increment(key);
    try {
      const remote = await this.remote.increment(key);
      if (!Number.isSafeInteger(remote?.totalHits) || remote.totalHits < 1
          || !(remote.resetTime instanceof Date) || !Number.isFinite(remote.resetTime.getTime())) {
        throw new TypeError('Invalid rate-limit counter');
      }
      return remote.totalHits >= local.totalHits ? remote : local;
    } catch {
      logger.warn('Rate limiter Redis unavailable; using local counters', { prefix: this.prefix });
      return local;
    }
  }

  async decrement(key) {
    await this.local.decrement(key);
    try { await this.remote.decrement(key); } catch { /* Local count is retained. */ }
  }

  async resetKey(key) {
    await this.local.resetKey(key);
    try { await this.remote.resetKey(key); } catch { /* Remote keys expire normally. */ }
  }

  shutdown() { this.local.shutdown(); }
}

module.exports = { ResilientRateLimitStore };
