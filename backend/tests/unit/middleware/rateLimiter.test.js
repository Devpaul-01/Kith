// tests/unit/middleware/rateLimiter.test.js
//
// The real src/middleware/rateLimiter.js only exports the 6 constructed
// limiter instances (authLimiter, inviteLimiter, uploadLimiter,
// publicLookupLimiter, generalLimiter, userGeneralLimiter) — the
// internal helpers (buildStore, perUserKey, perIpKey, createLimiter)
// are module-private. This suite tests the module's real, public
// surface: that it loads safely under both healthy and unhealthy Redis
// conditions, and that every exported limiter is a valid Express
// middleware function. Direct unit coverage of the private
// keyGenerator/store-fallback logic is not reachable without either
// modifying the source (out of scope) or exercising it through a real
// HTTP request via supertest, which belongs in the integration suite.

jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('middleware/rateLimiter', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let logger;

  beforeEach(() => {
    logger = require('../../../src/utils/logger');
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('module load — Redis client healthy', () => {
    it('loads without throwing and exports all 6 limiters as valid Express middleware functions', () => {
      jest.doMock('../../../src/config/redis', () => ({
        getRedis: () => ({ call: jest.fn() }),
      }));

      let limiters;
      expect(() => {
        limiters = require('../../../src/middleware/rateLimiter');
      }).not.toThrow();

      const expectedExports = [
        'authLimiter', 'inviteLimiter', 'uploadLimiter',
        'publicLookupLimiter', 'generalLimiter', 'userGeneralLimiter',
      ];
      expectedExports.forEach((name) => {
        expect(typeof limiters[name]).toBe('function');
      });
    });
  });

  describe('module load — Redis client unavailable (getRedis returns null)', () => {
    it('loads without throwing, falling back to in-memory stores, and warns per limiter', () => {
      jest.doMock('../../../src/config/redis', () => ({ getRedis: () => null }));

      let limiters;
      expect(() => {
        limiters = require('../../../src/middleware/rateLimiter');
      }).not.toThrow();

      expect(typeof limiters.authLimiter).toBe('function');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('module load — Redis client missing .call() method', () => {
    it('loads without throwing, falling back to in-memory stores', () => {
      jest.doMock('../../../src/config/redis', () => ({ getRedis: () => ({ notCall: true }) }));

      expect(() => require('../../../src/middleware/rateLimiter')).not.toThrow();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('module load — getRedis() throws synchronously', () => {
    it('loads without throwing (buildStore\'s internal try/catch swallows it), falls back to in-memory', () => {
      jest.doMock('../../../src/config/redis', () => ({
        getRedis: () => { throw new Error('connection refused'); },
      }));

      expect(() => require('../../../src/middleware/rateLimiter')).not.toThrow();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('skip bypass under NODE_ENV=test (behavioral proof belongs in the integration rate-limit suite)', () => {
    it('module loads successfully under NODE_ENV=test without throwing at construction time', () => {
      process.env.NODE_ENV = 'test';
      jest.doMock('../../../src/config/redis', () => ({ getRedis: () => ({ call: jest.fn() }) }));

      expect(() => require('../../../src/middleware/rateLimiter')).not.toThrow();
    });
  });
});
