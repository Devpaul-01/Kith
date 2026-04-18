
// tests/middleware/role.test.js
const { requireAdmin, requireSelfOrAdmin } = require('../../src/middleware/role');

describe('requireAdmin', () => {
  it('calls next() for admin role', () => {
    const req = { member: { role: 'admin' } };
    const next = jest.fn();
    requireAdmin(req, {}, next);
    expect(next).toHaveBeenCalledWith(); // no error
  });

  it('calls next(ForbiddenError) for member role', () => {
    const req = { member: { role: 'member' } };
    const next = jest.fn();
    requireAdmin(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });

  it('calls next(ForbiddenError) when member is null', () => {
    const req = { member: null };
    const next = jest.fn();
    requireAdmin(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('requireSelfOrAdmin', () => {
  it('allows admin to access any member', () => {
    const req = { member: { role: 'admin', id: 'admin-1' }, params: { memberId: 'member-99' } };
    const next = jest.fn();
    requireSelfOrAdmin()(req, {}, next);
    expect(next).toHaveBeenCalledWith(); // allowed
  });

  it('allows member to access their own resource', () => {
    const req = { member: { role: 'member', id: 'member-1' }, params: { memberId: 'member-1' } };
    const next = jest.fn();
    requireSelfOrAdmin()(req, {}, next);
    expect(next).toHaveBeenCalledWith(); // allowed
  });

  it('blocks member from accessing someone else\'s resource', () => {
    const req = { member: { role: 'member', id: 'member-1' }, params: { memberId: 'member-2' } };
    const next = jest.fn();
    requireSelfOrAdmin()(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});
