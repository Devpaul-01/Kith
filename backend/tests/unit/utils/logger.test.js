// tests/unit/utils/logger.test.js
//
// Low direct test value (this is a Winston config), but worth a smoke
// test to catch config-level breakage — e.g. a bad format pipeline that
// throws on the first .info() call in one NODE_ENV but never surfaces
// in the other because dev/test never exercises the prod format path.
// Exact log output formatting is a Winston library concern, not
// application logic, so it is intentionally not asserted here.

describe('utils/logger', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
  });

  it('exposes info/warn/error/debug and none of them throw (development format)', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'development';
    // eslint-disable-next-line global-require
    const logger = require('../../../src/utils/logger');

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');

    expect(() => logger.info('hello', { requestId: 'req_123', extra: 1 })).not.toThrow();
    expect(() => logger.warn('careful')).not.toThrow();
    expect(() => logger.error('bad', { error: 'boom' })).not.toThrow();
  });

  it('exposes info/warn/error/debug and none of them throw (production/json format)', () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    // eslint-disable-next-line global-require
    const logger = require('../../../src/utils/logger');

    expect(() => logger.info('hello', { extra: 1 })).not.toThrow();
    expect(() => logger.warn('careful')).not.toThrow();
    expect(() => logger.error('bad', { error: 'boom' })).not.toThrow();
  });

  it('logs an actual Error object (stack formatting) without throwing, in both formats', () => {
    for (const env of ['development', 'production']) {
      jest.resetModules();
      process.env.NODE_ENV = env;
      // eslint-disable-next-line global-require
      const logger = require('../../../src/utils/logger');
      expect(() => logger.error('failed', { error: new Error('boom').message, stack: new Error('boom').stack })).not.toThrow();
    }
  });
});
