const { ForbiddenError } = require('../../utils/errors');

/**
 * Context is supplied by server code after requireAuth/loadDbUser/
 * requireMembership. It must never be built from model arguments.
 * Shape: { userId: req.user.id, member: req.member, workspace: req.workspace }.
 */
function assertAgentContext(context, minRole = 'member') {
  const member = context?.member;
  const workspace = context?.workspace;
  const hasId = (id) => typeof id === 'string' && id.trim().length > 0;

  if (!hasId(context?.userId) || !hasId(member?.id) || !hasId(workspace?.id)
      || member.workspaceId !== workspace.id || member.isActive !== true
      || !['member', 'admin'].includes(member.role)) {
    throw new ForbiddenError('Active workspace membership required');
  }

  if (minRole === 'admin' && member.role !== 'admin') {
    throw new ForbiddenError('Admin access required');
  }

  // Unknown permission requirements must never grant access.
  if (!['member', 'admin'].includes(minRole)) {
    throw new ForbiddenError('Tool access denied');
  }
}

module.exports = { assertAgentContext };
