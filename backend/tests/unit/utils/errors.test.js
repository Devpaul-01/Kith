// tests/unit/utils/errors.test.js
const {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  BusinessRuleError,
  RateLimitError,
} = require('../../../src/utils/errors');

describe('utils/errors', () => {
  describe('AppError (base class)', () => {
    it('sets message, statusCode, code, details, and name exactly as constructed', () => {
      const err = new AppError('boom', 500, 'INTERNAL_ERROR', { extra: 1 });
      expect(err.message).toBe('boom');
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.details).toEqual({ extra: 1 });
      expect(err.name).toBe('AppError');
      expect(err).toBeInstanceOf(Error);
    });

    it('defaults details to null when omitted', () => {
      const err = new AppError('boom', 500, 'INTERNAL_ERROR');
      expect(err.details).toBeNull();
    });

    it('captures a stack trace that does not include the AppError constructor frame', () => {
      const err = new AppError('boom', 500, 'INTERNAL_ERROR');
      expect(err.stack).toBeDefined();
      // captureStackTrace(this, this.constructor) excludes the constructor's own frame.
      const firstStackLine = err.stack.split('\n')[1] || '';
      expect(firstStackLine).not.toMatch(/new AppError/);
    });
  });

  // Table-driven test over every subclass: each must set the documented
  // statusCode/code defaults and must NOT override `.name` away from
  // 'AppError' (errorHandler.js branches on `instanceof AppError`, not
  // on `.name`, but a silent divergence here is still worth locking in).
  describe.each([
    ['ValidationError', ValidationError, 400, 'VALIDATION_FAILED'],
    ['UnauthorizedError', UnauthorizedError, 401, 'UNAUTHORIZED'],
    ['ForbiddenError', ForbiddenError, 403, 'FORBIDDEN'],
    ['NotFoundError', NotFoundError, 404, 'NOT_FOUND'],
    ['ConflictError', ConflictError, 409, 'CONFLICT'],
    ['BusinessRuleError', BusinessRuleError, 422, 'BUSINESS_RULE_VIOLATION'],
    ['RateLimitError', RateLimitError, 429, 'RATE_LIMITED'],
  ])('%s', (name, ErrorClass, expectedStatus, expectedCode) => {
    it(`defaults to statusCode ${expectedStatus} and code ${expectedCode}`, () => {
      const err = new ErrorClass();
      expect(err.statusCode).toBe(expectedStatus);
      expect(err.code).toBe(expectedCode);
      expect(err.name).toBe('AppError');
      expect(err).toBeInstanceOf(AppError);
    });

    it('uses a provided message when passed', () => {
      const err = new ErrorClass('custom message');
      expect(err.message).toBe('custom message');
    });
  });

  describe('UnauthorizedError / ForbiddenError / NotFoundError default messages', () => {
    it('UnauthorizedError defaults to "Authentication required"', () => {
      expect(new UnauthorizedError().message).toBe('Authentication required');
    });

    it('ForbiddenError defaults to "Access denied"', () => {
      expect(new ForbiddenError().message).toBe('Access denied');
    });

    it('NotFoundError defaults to "Resource not found"', () => {
      expect(new NotFoundError().message).toBe('Resource not found');
    });

    it('RateLimitError defaults to "Too many requests"', () => {
      expect(new RateLimitError().message).toBe('Too many requests');
    });
  });

  describe('ValidationError', () => {
    it('attaches field and details when passed', () => {
      const err = new ValidationError('bad input', 'email', { reason: 'invalid format' });
      expect(err.field).toBe('email');
      expect(err.details).toEqual({ reason: 'invalid format' });
    });

    it('defaults field and details to null when omitted', () => {
      const err = new ValidationError('bad input');
      expect(err.field).toBeNull();
      expect(err.details).toBeNull();
    });
  });

  describe('ConflictError / BusinessRuleError details', () => {
    it('ConflictError attaches details when passed, null when omitted', () => {
      const withDetails = new ConflictError('dup', { existing_entry_id: 'abc' });
      expect(withDetails.details).toEqual({ existing_entry_id: 'abc' });

      const withoutDetails = new ConflictError('dup');
      expect(withoutDetails.details).toBeNull();
    });

    it('BusinessRuleError attaches details when passed, null when omitted', () => {
      const withDetails = new BusinessRuleError('nope', { rule: 'x' });
      expect(withDetails.details).toEqual({ rule: 'x' });

      const withoutDetails = new BusinessRuleError('nope');
      expect(withoutDetails.details).toBeNull();
    });
  });
});
