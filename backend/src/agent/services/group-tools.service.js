const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listGroupsArgsSchema, getGroupArgsSchema, MAX_GROUP_PAGE } = require('../validators/group-tools.validator');

const GROUP_FIELDS = Object.freeze(['id', 'name', 'description', 'created_at', 'updated_at']);
const MEMBER_FIELDS = Object.freeze([
  'id', 'display_name', 'role', 'is_proxy', 'is_active', 'relationship_to_head', 'relationship_category', 'added_at',
]);
const fieldsFrom = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
function pageMeta(count, page, perPage) {
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return { ...pagination, next_page: page < pagination.total_pages && page < MAX_GROUP_PAGE ? page + 1 : null };
}

async function listGroups({ context, args }) {
  assertAgentContext(context);
  const parsed = listGroupsArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid group arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    workspaceId: context.workspace.id, search: parsed.data.search, pagination: { page, perPage, offset },
  };
  const groupService = require('../../services/group.service');
  const { groups, count } = await groupService.listGroups(parameters);
  return { groups: groups.map((group) => fieldsFrom(group, GROUP_FIELDS)), pagination: pageMeta(count, page, perPage) };
}

async function getGroup({ context, args }) {
  // Unlike group browsing, the HTTP group-detail route is admin-only.
  assertAgentContext(context, 'admin');
  const parsed = getGroupArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid group arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    workspaceId: context.workspace.id, groupId: parsed.data.group_id, pagination: { page, perPage, offset },
  };
  const groupService = require('../../services/group.service');
  const { group, members, count } = await groupService.getGroup(parameters);
  return {
    group: fieldsFrom(group, GROUP_FIELDS), members: members.map((member) => fieldsFrom(member, MEMBER_FIELDS)),
    pagination: pageMeta(count, page, perPage),
  };
}

module.exports = { listGroups, getGroup };
