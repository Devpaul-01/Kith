// src/middleware/role.js
const { ForbiddenError } = require('../utils/errors');

/**
 * requireAdmin — must be used AFTER requireMembership.
 * Returns 403 if caller is not an admin.
 */
function requireAdmin(req, res, next) {
  if (!req.member || req.member.role !== 'admin') {
    return next(new ForbiddenError('Admin access required'));
  }
  next();
}

/**
 * requireSelfOrAdmin — allows the resource owner OR any admin.
 * Pass a function that resolves the owner's workspace_member id
 * from req params/body. Usually req.params.memberId.
 */
function requireSelfOrAdmin(getMemberId = (req) => req.params.memberId) {
  return (req, res, next) => {
    const targetMemberId = getMemberId(req);
    if (req.member.role === 'admin' || req.member.id === targetMemberId) {
      return next();
    }
    next(new ForbiddenError('You do not have permission to access this resource'));
  };
}

module.exports = { requireAdmin, requireSelfOrAdmin };
