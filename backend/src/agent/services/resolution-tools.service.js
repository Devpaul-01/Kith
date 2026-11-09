const searchService = require('../../services/search.service');
const { assertAgentContext } = require('./context.service');
const { ValidationError } = require('../../utils/errors');
const { entitySearchSchema, containerEntitySearchSchema } = require('../../validators/search.validator');

async function findMember({ args, context }) {
  assertAgentContext(context);
  return searchService.findMembers({
    workspaceId: context.workspace.id,
    query: args?.query,
    limit: args?.limit,
  });
}

async function findContainer({ args, context }) {
  assertAgentContext(context);
  return searchService.findContainers({
    workspaceId: context.workspace.id,
    query: args?.query,
    limit: args?.limit,
  });
}

function parseSearchArgs(schema, args) {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid search arguments', null, parsed.error.issues);
  return parsed.data;
}

async function findTasks({ args, context }) {
  assertAgentContext(context);
  const { query, limit, container_id } = parseSearchArgs(containerEntitySearchSchema, args);
  return searchService.findTasks({
    workspaceId: context.workspace.id, callerId: context.member.id,
    isAdmin: context.member.role === 'admin', query, limit, containerId: container_id,
  });
}

async function findLedgerEntries({ args, context }) {
  assertAgentContext(context);
  const { query, limit, container_id } = parseSearchArgs(containerEntitySearchSchema, args);
  return searchService.findLedgerEntries({
    workspaceId: context.workspace.id, callerId: context.member.id,
    isAdmin: context.member.role === 'admin', query, limit, containerId: container_id,
  });
}

async function findDisputes({ args, context }) {
  assertAgentContext(context);
  const { query, limit } = parseSearchArgs(entitySearchSchema, args);
  return searchService.findDisputes({
    workspaceId: context.workspace.id, callerId: context.member.id,
    isAdmin: context.member.role === 'admin', query, limit,
  });
}

async function findGroup({ args, context }) {
  assertAgentContext(context);
  const { query, limit } = parseSearchArgs(entitySearchSchema, args);
  return searchService.findGroups({ workspaceId: context.workspace.id, query, limit });
}

module.exports = { findMember, findContainer, findTasks, findLedgerEntries, findDisputes, findGroup };
