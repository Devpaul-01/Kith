const { z } = require('zod');
const { ValidationError, NotFoundError, BusinessRuleError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { assertAgentContext } = require('./context.service');
const { getMyContext, getDashboard, getOverdueSummary } = require('./read-tools.service');

const tools = Object.freeze([
  Object.freeze({
    name: 'get_my_context',
    description: 'Get your identity, role, and current workspace.',
    parameterSchema: z.object({}).strict(),
    minRole: 'member',
    tier: 0,
    handler: getMyContext,
  }),
  Object.freeze({
    name: 'get_dashboard',
    description: 'Get the current workspace dashboard with your permitted view and personal task summary.',
    parameterSchema: z.object({}).strict(),
    minRole: 'member',
    tier: 1,
    handler: getDashboard,
  }),
  Object.freeze({
    name: 'get_overdue_summary',
    description: 'Get the workspace overdue contribution summary. Admin access required.',
    parameterSchema: z.object({}).strict(),
    minRole: 'admin',
    tier: 1,
    handler: getOverdueSummary,
  }),
]);

/** Return role-filtered definitions; executable handlers stay private. */
function getAvailableTools(context) {
  assertAgentContext(context);
  return Object.freeze(tools
    .filter((tool) => tool.minRole === 'member' || context.member.role === 'admin')
    .map(({ handler, ...definition }) => Object.freeze(definition)));
}

/**
 * Execute validated reads only. A future proposal executor must be a
 * separate entry point; no model-controlled flag can enable writes here.
 * Results remain service data, including any untrusted user-generated text.
 */
async function executeReadTool({ name, args = {}, context }) {
  const startedAt = Date.now();
  const tool = tools.find((candidate) => candidate.name === name);
  const trace = {
    toolName: typeof name === 'string' ? name : null,
    tier: tool?.tier,
    workspaceId: context?.workspace?.id,
    actorUserId: context?.userId,
    actorMemberId: context?.member?.id,
  };

  try {
    assertAgentContext(context);
    if (!tool) throw new NotFoundError('Agent tool not found');
    assertAgentContext(context, tool.minRole);
    if (tool.tier > 1) {
      throw new BusinessRuleError('Write tools require an approved proposal');
    }

    const parsed = tool.parameterSchema.safeParse(args);
    if (!parsed.success) {
      throw new ValidationError('Invalid tool arguments', null, parsed.error.issues);
    }

    trace.parameters = parsed.data;
    const result = await tool.handler({ context, args: parsed.data });
    logger.info('Agent read tool completed', {
      ...trace, result, durationMs: Date.now() - startedAt, outcome: 'success',
    });
    return result;
  } catch (err) {
    logger.warn('Agent read tool failed', {
      ...trace,
      error: err.message,
      errorCode: err.code,
      durationMs: Date.now() - startedAt,
      outcome: 'error',
    });
    throw err;
  }
}

module.exports = { getAvailableTools, executeReadTool };
