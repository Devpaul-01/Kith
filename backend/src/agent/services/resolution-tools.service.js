const searchService = require('../../services/search.service');
const { assertAgentContext } = require('./context.service');

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

module.exports = { findMember, findContainer };
