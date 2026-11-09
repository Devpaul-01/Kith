const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listInvitesArgsSchema, MAX_INVITE_PAGE } = require('../validators/invite-tools.validator');

async function listInvites({ context, args }) {
  assertAgentContext(context, 'admin');
  const parsed = listInvitesArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid invite arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = { workspaceId: context.workspace.id, statusFilter: parsed.data.status, pagination: { page, perPage, offset } };
  const inviteService = require('../../services/invite.service');
  const { invites, count, asOf } = await inviteService.listInvites(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    invites: invites.map((invite) => ({
      id: invite.id, created_by: invite.created_by, created_by_name: invite.created_by_name,
      created_at: invite.created_at, expires_at: invite.expires_at, used_at: invite.used_at, status: invite.status,
    })),
    as_of: asOf,
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_INVITE_PAGE ? page + 1 : null },
  };
}

module.exports = { listInvites };
