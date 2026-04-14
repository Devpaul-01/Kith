const { requireAdmin } = require('../../src/middleware/role');
const { ForbiddenError } = require('../../src/utils/errors');

describe('requireAdmin', () => {

  // Helpers — fake Express req, res, next
  function makeReq(memberRole) {
    return { member: { role: memberRole, id: 'member-123' } };
  }
  const res  = {}; // not used by requireAdmin
  const next = jest.fn(); // capture what's passed to next()

  beforeEach(() => {
    next.mockClear(); // reset the mock before each test
  });

  test('should call next() without error when member is admin', () => {
    // ARRANGE
    const req = makeReq('admin');

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    expect(next).toHaveBeenCalledWith(); // called with no arguments = success
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('should call next(ForbiddenError) when member is not admin', () => {
    // ARRANGE
    const req = makeReq('member');

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    expect(next).toHaveBeenCalledTimes(1);
    const errorPassedToNext = next.mock.calls[0][0]; // first argument of first call
    expect(errorPassedToNext).toBeInstanceOf(ForbiddenError);
    expect(errorPassedToNext.message).toBe('Admin access required');
  });

  test('should call next(ForbiddenError) when req.member is not set', () => {
    // ARRANGE
    const req = { member: null }; // no member

    // ACT
    requireAdmin(req, res, next);

    // ASSERT
    const errorPassedToNext = next.mock.calls[0][0];
    expect(errorPassedToNext).toBeInstanceOf(ForbiddenError);
  });

});