const { ForbiddenError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');

/** Re-read membership before any proposal receipt or decision is exposed. */
async function assertCurrentActor(context) {
  assertAgentContext(context);
  const members = require('../../services/member.service');
  const member = await members.getActiveMembership({
    workspaceId: context.workspace.id,
    userId: context.userId,
  });
  if (member.id !== context.member.id || member.workspace_id !== context.workspace.id
      || member.user_id !== context.userId || member.is_active !== true
      || member.role !== context.member.role) {
    throw new ForbiddenError('Workspace membership changed. Please retry.');
  }
}

module.exports = { assertCurrentActor };
