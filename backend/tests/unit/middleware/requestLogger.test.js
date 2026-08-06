// tests/unit/middleware/requestLogger.test.js
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../../src/utils/logger');
const { requestId, requestLogger } = require('../../../src/middleware/requestLogger');
const { mockReq, mockRes, mockNext } = require('../../helpers/mockReqRes');

describe('middleware/requestLogger', () => {
  describe('requestId', () => {
    it('sets req.requestId, sets the X-Request-Id header, and calls next()', () => {
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      requestId(req, res, next);

      expect(typeof req.requestId).toBe('string');
      expect(req.requestId.length).toBeGreaterThan(0);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
      expect(next).toHaveBeenCalledWith();
    });

    it('produces a different id on consecutive calls', () => {
      const req1 = mockReq();
      const req2 = mockReq();
      requestId(req1, mockRes(), mockNext());
      requestId(req2, mockRes(), mockNext());
      expect(req1.requestId).not.toBe(req2.requestId);
    });
  });

  describe('requestLogger', () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
      [199, 'info'],
      [200, 'info'],
      [399, 'info'],
      [400, 'warn'],
      [404, 'warn'],
      [499, 'warn'],
      [500, 'error'],
      [503, 'error'],
    ])('status %i logs at level "%s"', (status, level) => {
      const req = mockReq({ method: 'GET', path: '/v1/workspaces' });
      const res = mockRes({ statusCode: status });
      const next = mockNext();

      requestLogger(req, res, next);
      expect(next).toHaveBeenCalledWith();
      res.triggerFinish();

      expect(logger[level]).toHaveBeenCalledTimes(1);
      const otherLevels = ['info', 'warn', 'error'].filter((l) => l !== level);
      otherLevels.forEach((l) => expect(logger[l]).not.toHaveBeenCalled());
    });

    it('logs the full expected metadata shape', () => {
      const req = mockReq({
        method: 'PATCH',
        path: '/v1/workspaces/ws1/members/m1',
        params: { workspaceId: 'ws1' },
        user: { id: 'user-1' },
        member: { id: 'member-1' },
      });
      const res = mockRes({ statusCode: 200 });

      requestLogger(req, res, mockNext());
      res.triggerFinish();

      expect(logger.info).toHaveBeenCalledWith('PATCH /v1/workspaces/ws1/members/m1', {
        request_id: undefined,
        method: 'PATCH',
        path: '/v1/workspaces/ws1/members/m1',
        status: 200,
        duration_ms: expect.any(Number),
        user_id: 'user-1',
        workspace_id: 'ws1',
        workspace_member_id: 'member-1',
      });
    });

    it('user_id/workspace_id/workspace_member_id are undefined (not throwing) for a pre-auth request', () => {
      const req = mockReq({ method: 'GET', path: '/health' }); // no user/params/member
      const res = mockRes({ statusCode: 200 });

      requestLogger(req, res, mockNext());
      expect(() => res.triggerFinish()).not.toThrow();

      const meta = logger.info.mock.calls[0][1];
      expect(meta.user_id).toBeUndefined();
      expect(meta.workspace_id).toBeUndefined();
      expect(meta.workspace_member_id).toBeUndefined();
    });

    it('computes duration_ms from an exact elapsed time using fake timers', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const req = mockReq();
      const res = mockRes({ statusCode: 200 });
      requestLogger(req, res, mockNext());

      jest.setSystemTime(new Date('2026-01-01T00:00:00.250Z')); // +250ms
      res.triggerFinish();

      const meta = logger.info.mock.calls[0][1];
      expect(meta.duration_ms).toBe(250);

      jest.useRealTimers();
    });
  });
});
