// tests/unit/middleware/errorHandler.test.js
const { z, ZodError } = require('zod');
const { errorHandler } = require('../../../src/middleware/errorHandler');
const {
  AppError, NotFoundError, ValidationError, BusinessRuleError,
} = require('../../../src/utils/errors');
const { mockReq, mockRes, mockNext } = require('../../helpers/mockReqRes');

jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
const logger = require('../../../src/utils/logger');

function makeZodError() {
  const schema = z.object({ email: z.string().email(), age: z.number().min(18) });
  try {
    schema.parse({ email: 'not-an-email', age: 5 });
  } catch (err) {
    return err;
  }
  throw new Error('expected schema.parse to throw');
}

describe('middleware/errorHandler', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('ZodError handling', () => {
    it('returns 400 VALIDATION_FAILED using the first issue message and field path', () => {
      const err = makeZodError();
      const req = mockReq();
      const res = mockRes();

      errorHandler(err, req, res, mockNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(body.error.field).toBe(err.errors[0].path.join('.'));
      expect(body.error.message).toBe(err.errors[0].message);
    });

    it('includes ALL issues in details, even though message/field reflect only the first', () => {
      const err = makeZodError(); // has 2 issues: email + age
      expect(err.errors.length).toBe(2);

      const res = mockRes();
      errorHandler(err, mockReq(), res, mockNext());

      const body = res.json.mock.calls[0][0];
      expect(body.error.details).toHaveLength(2);
      expect(body.error.details[0]).toEqual({
        field: err.errors[0].path.join('.'),
        message: err.errors[0].message,
        code: err.errors[0].code,
      });
    });
  });

  describe('AppError handling', () => {
    it('4xx AppError: correct status/code/message and does NOT call logger.error', () => {
      const err = new NotFoundError('Widget not found');
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'NOT_FOUND', message: 'Widget not found' },
      });
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('5xx AppError (constructed directly): logs via logger.error with request_id/code/message/stack', () => {
      const err = new AppError('boom', 500, 'INTERNAL');
      const req = mockReq({ requestId: 'req_abc123' });
      const res = mockRes();

      errorHandler(err, req, res, mockNext());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(logger.error).toHaveBeenCalledWith('Application error', expect.objectContaining({
        request_id: 'req_abc123',
        code: 'INTERNAL',
        message: 'boom',
      }));
    });

    it('includes err.field in the body only when truthy', () => {
      const withField = new ValidationError('bad', 'email');
      const res1 = mockRes();
      errorHandler(withField, mockReq(), res1, mockNext());
      expect(res1.json.mock.calls[0][0].error.field).toBe('email');

      const withoutField = new ValidationError('bad', null);
      const res2 = mockRes();
      errorHandler(withoutField, mockReq(), res2, mockNext());
      expect(res2.json.mock.calls[0][0].error).not.toHaveProperty('field');
    });

    it('treats an empty-string field as falsy/absent (current documented behavior)', () => {
      const err = new ValidationError('bad', '');
      const res = mockRes();
      errorHandler(err, mockReq(), res, mockNext());
      expect(res.json.mock.calls[0][0].error).not.toHaveProperty('field');
    });

    it('includes err.details in the body only when truthy', () => {
      const withDetails = new BusinessRuleError('nope', { rule: 'x' });
      const res1 = mockRes();
      errorHandler(withDetails, mockReq(), res1, mockNext());
      expect(res1.json.mock.calls[0][0].error.details).toEqual({ rule: 'x' });

      const withoutDetails = new BusinessRuleError('nope');
      const res2 = mockRes();
      errorHandler(withoutDetails, mockReq(), res2, mockNext());
      expect(res2.json.mock.calls[0][0].error).not.toHaveProperty('details');
    });
  });

  describe('raw Postgres error codes', () => {
    it('23505 (unique violation) -> 409 CONFLICT with a generic message, never leaking err.message', () => {
      const err = { code: '23505', message: 'duplicate key value violates unique constraint "idx_x"' };
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      expect(res.status).toHaveBeenCalledWith(409);
      const body = res.json.mock.calls[0][0];
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.message).toBe('A record with this data already exists.');
      expect(body.error.message).not.toContain('idx_x');
    });

    it('23503 (FK violation) -> 422 BUSINESS_RULE_VIOLATION with a generic message, never leaking err.message', () => {
      const err = { code: '23503', message: 'insert or update on table violates foreign key constraint' };
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.error.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(body.error.message).toBe('Referenced resource does not exist.');
    });
  });

  describe('unhandled/unknown errors — the information-disclosure boundary', () => {
    it('production: returns the generic message, NOT err.message', () => {
      process.env.NODE_ENV = 'production';
      const err = new Error('leaked secret detail about internal schema');
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error.message).toBe('An internal error occurred');
      expect(body.error.message).not.toContain('leaked secret');
    });

    it('non-production (development): returns err.message directly', () => {
      process.env.NODE_ENV = 'development';
      const err = new Error('helpful debug detail');
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      const body = res.json.mock.calls[0][0];
      expect(body.error.message).toBe('helpful debug detail');
    });

    it('non-production (test/unset): also returns err.message directly', () => {
      process.env.NODE_ENV = 'test';
      const err = new Error('debug detail in test env');
      const res = mockRes();

      errorHandler(err, mockReq(), res, mockNext());

      expect(res.json.mock.calls[0][0].error.message).toBe('debug detail in test env');
    });

    it('logs the full message/stack via logger.error regardless of NODE_ENV', () => {
      process.env.NODE_ENV = 'production';
      const err = new Error('boom');
      const req = mockReq({ requestId: 'req_xyz' });
      const res = mockRes();

      errorHandler(err, req, res, mockNext());

      expect(logger.error).toHaveBeenCalledWith('Unhandled error', expect.objectContaining({
        request_id: 'req_xyz',
        message: 'boom',
      }));
    });

    it('never throws even when the error object is malformed (e.g. missing .message)', () => {
      const res = mockRes();
      expect(() => errorHandler({}, mockReq(), res, mockNext())).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
