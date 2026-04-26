// tests/middleware/errorHandler.test.js
const { errorHandler } = require('../../src/middleware/errorHandler');
const { AppError } = require('../../src/utils/errors');
const { ZodError } = require('zod');
const logger = require('../../src/utils/logger');

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

describe('errorHandler Middleware', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock request with requestId
    req = {
      requestId: 'test-request-123',
    };
    
    // Mock response
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    
    // Mock next (not used in this middleware)
    next = jest.fn();
  });

  describe('Zod Validation Errors', () => {
    it('should return 400 with validation details for ZodError', () => {
      // Create a mock ZodError
      const zodError = new ZodError([
        {
          message: 'Email must be valid',
          path: ['email'],
          code: 'invalid_string',
        },
        {
          message: 'Age must be at least 18',
          path: ['age'],
          code: 'too_small',
        },
      ]);

      errorHandler(zodError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Email must be valid', // First error message
          field: 'email',
          details: [
            {
              field: 'email',
              message: 'Email must be valid',
              code: 'invalid_string',
            },
            {
              field: 'age',
              message: 'Age must be at least 18',
              code: 'too_small',
            },
          ],
        },
      });
    });

    it('should handle nested field paths in ZodError', () => {
      const zodError = new ZodError([
        {
          message: 'Required',
          path: ['user', 'profile', 'name'],
          code: 'invalid_type',
        },
      ]);

      errorHandler(zodError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            field: 'user.profile.name',
            details: expect.arrayContaining([
              expect.objectContaining({ field: 'user.profile.name' }),
            ]),
          }),
        })
      );
    });
  });

  describe('AppError (Known Application Errors)', () => {
    it('should return status code and error from AppError (4xx)', () => {
      const appError = new AppError('Resource not found', 404, 'NOT_FOUND');
      
      errorHandler(appError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found',
        },
      });
    });

    it('should include field when present in AppError', () => {
      const appError = new AppError('Invalid email format', 400, 'VALIDATION_ERROR');
      appError.field = 'email';
      
      errorHandler(appError, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid email format',
          field: 'email',
        },
      });
    });

    it('should include details when present in AppError', () => {
      const appError = new AppError('Business rule violated', 422, 'BUSINESS_RULE');
      appError.details = { minAmount: 100, providedAmount: 50 };
      
      errorHandler(appError, req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'BUSINESS_RULE',
          message: 'Business rule violated',
          details: { minAmount: 100, providedAmount: 50 },
        },
      });
    });

    it('should log error for 5xx status codes', () => {
      const appError = new AppError('Database connection lost', 500, 'DB_ERROR');
      appError.stack = 'Error stack trace...';
      
      errorHandler(appError, req, res, next);

      expect(logger.error).toHaveBeenCalledWith('Application error', {
        request_id: 'test-request-123',
        code: 'DB_ERROR',
        message: 'Database connection lost',
        stack: 'Error stack trace...',
      });
    });

    it('should NOT log error for 4xx status codes', () => {
      const appError = new AppError('Bad request', 400, 'BAD_REQUEST');
      
      errorHandler(appError, req, res, next);

      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('Postgres Database Errors', () => {
    it('should return 409 for unique violation (23505)', () => {
      const dbError = new Error('Duplicate key violation');
      dbError.code = '23505';
      
      errorHandler(dbError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'CONFLICT',
          message: 'A record with this data already exists.',
        },
      });
      //expect(logger.error).toHaveBeenCalled(); // Unhandled error logger
    });

    it('should return 422 for foreign key violation (23503)', () => {
      const dbError = new Error('Foreign key violation');
      dbError.code = '23503';
      
      errorHandler(dbError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'Referenced resource does not exist.',
        },
      });
    });

    it('should handle other Postgres errors as unhandled', () => {
      const dbError = new Error('Check constraint violation');
      dbError.code = '23514'; // Check violation
      
      errorHandler(dbError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Unhandled / Unexpected Errors', () => {
    beforeEach(() => {
      // Reset NODE_ENV for each test
      delete process.env.NODE_ENV;
    });

    it('should return 500 with generic message in production', () => {
      process.env.NODE_ENV = 'production';
      const unexpectedError = new Error('Something went wrong');
      
      errorHandler(unexpectedError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred',
        },
      });
    });

    it('should return 500 with actual error message in development', () => {
      process.env.NODE_ENV = 'development';
      const unexpectedError = new Error('Database timeout');
      
      errorHandler(unexpectedError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Database timeout',
        },
      });
    });

    it('should log unhandled errors with request_id and stack', () => {
      const unexpectedError = new Error('Unexpected failure');
      unexpectedError.stack = 'Error stack trace...';
      
      errorHandler(unexpectedError, req, res, next);

      expect(logger.error).toHaveBeenCalledWith('Unhandled error', {
        request_id: 'test-request-123',
        message: 'Unexpected failure',
        stack: 'Error stack trace...',
      });
    });

    it('should handle missing request_id gracefully', () => {
      req.requestId = undefined;
      const unexpectedError = new Error('Something broke');
      
      errorHandler(unexpectedError, req, res, next);

      expect(logger.error).toHaveBeenCalledWith('Unhandled error', {
        request_id: undefined,
        message: 'Something broke',
        stack: expect.any(String),
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle error with no message', () => {
      const error = new Error();
      error.message = undefined;
      
      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
          }),
        })
      );
    });

    it('should handle null/undefined error', () => {
      // This shouldn't happen in practice, but test defensively
      const error = {};

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(logger.error).toHaveBeenCalled();
    });

    it('should preserve AppError field even if undefined', () => {
      const appError = new AppError('Error', 400, 'ERROR');
      // field intentionally not set
      
      errorHandler(appError, req, res, next);

      const responseCall = res.json.mock.calls[0][0];
      expect(responseCall.error.field).toBeUndefined();
    });
  });
});