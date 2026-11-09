const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listMembersArgsSchema, getMemberArgsSchema, MAX_MEMBER_PAGE } = require('../validators/member-tools.validator');

const DIRECTORY_FIELDS = Object.freeze([
  'id', 'display_name', 'role', 'is_proxy', 'proxy_managed_by', 'relationship_to_head',
  'relationship_category', 'is_active', 'joined_at', 'updated_at',
]);
const directoryMember = (member) => Object.fromEntries(DIRECTORY_FIELDS.map((field) => [field, member[field]]));

async function listMembers({ context, args }) {
  assertAgentContext(context);
  const parsed = listMembersArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid member arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    workspaceId: context.workspace.id, isAdmin: context.member.role === 'admin',
    filterRole: parsed.data.role, filterProxy: parsed.data.is_proxy, filterActive: parsed.data.is_active,
    search: parsed.data.search, sortQuery: { sort: parsed.data.sort }, pagination: { page, perPage, offset },
  };
  const memberService = require('../../services/member.service');
  const { members, count } = await memberService.listMembers(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    members: members.map(directoryMember),
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_MEMBER_PAGE ? page + 1 : null },
  };
}

async function getMember({ context, args }) {
  // Read another member's directory entry, matching the member HTTP route.
  // This does not grant permission to update that member or act for a proxy.
  assertAgentContext(context);
  const parsed = getMemberArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid member arguments', null, parsed.error.issues);
  const parameters = {
    workspaceId: context.workspace.id, memberId: parsed.data.member_id,
    isAdmin: context.member.role === 'admin', metadataOnly: true,
  };
  const memberService = require('../../services/member.service');
  return { member: directoryMember(await memberService.getMember(parameters)) };
}

module.exports = { listMembers, getMember };
