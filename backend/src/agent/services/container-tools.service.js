const { ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listContainersArgsSchema, getContainerArgsSchema, MAX_CONTAINER_PAGE } = require('../validators/container-tools.validator');

const LIST_FIELDS = Object.freeze([
  'id', 'name', 'subtitle', 'container_type', 'status', 'enable_money', 'enable_tasks',
  'event_date', 'recurrence_cadence', 'recurrence_start', 'recurrence_end', 'created_at', 'updated_at', 'completed_at',
]);
const DETAIL_FIELDS = Object.freeze([
  ...LIST_FIELDS, 'description', 'event_type', 'event_type_category', 'budget_target', 'budget_currency',
  'recurrence_days', 'carry_forward_unpaid', 'auto_generate_cycles', 'outcome_details', 'converted_from_id',
]);
const fieldsFrom = (container, fields) => Object.fromEntries(fields.map((field) => [field, container[field]]));

async function listContainers({ context, args }) {
  // Both HTTP container reads are available to active members and admins.
  assertAgentContext(context);
  const parsed = listContainersArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid container arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = {
    workspaceId: context.workspace.id, typeFilter: parsed.data.type, statusFilter: parsed.data.status,
    sortQuery: { sort: parsed.data.sort }, includeDeleted: false, pagination: { page, perPage, offset },
  };
  const containerService = require('../../services/container.service');
  const { containers, count } = await containerService.listContainers(parameters);
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    containers: containers.map((container) => fieldsFrom(container, LIST_FIELDS)),
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_CONTAINER_PAGE ? page + 1 : null },
  };
}

async function getContainer({ context, args }) {
  assertAgentContext(context);
  const parsed = getContainerArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid container arguments', null, parsed.error.issues);
  const parameters = {
    workspaceId: context.workspace.id, containerId: parsed.data.container_id,
    callerMemberId: context.member.id, metadataOnly: true,
  };
  const containerService = require('../../services/container.service');
  const { container } = await containerService.getContainer(parameters);
  return { container: fieldsFrom(container, DETAIL_FIELDS) };
}

module.exports = { listContainers, getContainer };
