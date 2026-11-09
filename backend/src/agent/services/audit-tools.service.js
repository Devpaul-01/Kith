const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { getAuditLogArgsSchema, MAX_AUDIT_PAGE } = require('../validators/audit-tools.validator');

async function getAuditLog({ context, args }) {
  assertAgentContext(context, 'admin');
  const parsed = getAuditLogArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid audit-log arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const { action, actor_member_id, from, to } = parsed.data;
  const parameters = { workspaceId: context.workspace.id, filters: { action, actor_member_id, from, to }, page, perPage, offset, summaryOnly: true };
  const auditLogService = require('../../services/audit_log.service');
  const { entries, count } = await auditLogService.getAuditLog(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    entries: entries.map((entry) => ({
      id: entry.id, action: entry.action, actor_member_id: entry.actor_member_id, actor_name: entry.actor_name,
      target_type: entry.target_type, target_id: entry.target_id, created_at: entry.created_at,
    })),
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_AUDIT_PAGE ? page + 1 : null },
  };
}

module.exports = { getAuditLog };
