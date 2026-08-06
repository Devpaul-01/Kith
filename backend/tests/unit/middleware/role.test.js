// tests/unit/middleware/role.test.js
const { requireAdmin, requireSelfOrAdmin } = require('../../../src/middleware/role');
const { ForbiddenError } = require('../../../src/utils/errors');
const { mockReq, mockNext } = require('../../helpers/mockReqRes');

describe('middleware/role', () => {
  describe('requireAdmin', () => {
    it('calls next(ForbiddenError) when req.member is unset', () => {
      const req = mockReq();
      const next = mockNext();
      requireAdmin(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('calls next(ForbiddenError) when req.member.role is not admin', () => {
      const req = mockReq({ member: { role: 'member' } });
      const next = mockNext();
      requireAdmin(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('calls next() with no args when req.member.role is admin', () => {
      const req = mockReq({ member: { role: 'admin' } });
      const next = mockNext();
      requireAdmin(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('requireSelfOrAdmin', () => {
    it('default getMemberId: admin caller with ANY target -> next()', () => {
      const req = mockReq({
        member: { id: 'admin-1', role: 'admin' },
        params: { memberId: 'someone-else' },
      });
      const next = mockNext();
      requireSelfOrAdmin()(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('default getMemberId: non-admin caller matching req.member.id -> next()', () => {
      const req = mockReq({
        member: { id: 'member-1', role: 'member' },
        params: { memberId: 'member-1' },
      });
      const next = mockNext();
      requireSelfOrAdmin()(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('default getMemberId: non-admin caller with mismatched id -> next(ForbiddenError)', () => {
      const req = mockReq({
        member: { id: 'member-1', role: 'member' },
        params: { memberId: 'someone-else' },
      });
      const next = mockNext();
      requireSelfOrAdmin()(req, {}, next);
      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });

    it('invokes a custom getMemberId function with req, not ignoring it', () => {
      const getMemberId = jest.fn(() => 'custom-target-id');
      const req = mockReq({ member: { id: 'custom-target-id', role: 'member' } });
      const next = mockNext();

      requireSelfOrAdmin(getMemberId)(req, {}, next);

      expect(getMemberId).toHaveBeenCalledWith(req);
      expect(next).toHaveBeenCalledWith();
    });

    it('custom getMemberId returning a mismatched id still rejects a non-admin', () => {
      const getMemberId = () => 'not-the-caller';
      const req = mockReq({ member: { id: 'caller-1', role: 'member' } });
      const next = mockNext();

      requireSelfOrAdmin(getMemberId)(req, {}, next);

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    });
  });
});
