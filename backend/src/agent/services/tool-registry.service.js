const { z } = require('zod');
const { ValidationError, NotFoundError, BusinessRuleError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { assertAgentContext } = require('./context.service');
const { getMyContext, getDashboard, getOverdueSummary } = require('./read-tools.service');
const { findMember, findContainer } = require('./resolution-tools.service');
const { entitySearchSchema } = require('../../validators/search.validator');
const { getContainerSummary, getLedgerSummary, getMemberContributionSummary, getMemberEngagement } = require('./summary-tools.service');
const { containerSummaryArgsSchema, memberSummaryArgsSchema, memberEngagementArgsSchema } = require('../validators/summary-tools.validator');
const { listCycles } = require('./cycle-tools.service');
const { listCyclesArgsSchema } = require('../validators/cycle-tools.validator');
const { listTasks, getTask } = require('./task-tools.service');
const { listTasksArgsSchema, getTaskArgsSchema } = require('../validators/task-tools.validator');
const { listLedgerEntries, getLedgerEntry } = require('./ledger-tools.service');
const { listLedgerEntriesArgsSchema, getLedgerEntryArgsSchema } = require('../validators/ledger-tools.validator');
const { listNotifications, getUnreadCount } = require('./notification-tools.service');
const { listNotificationsArgsSchema, unreadCountArgsSchema } = require('../validators/notification-tools.validator');

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
    name: 'find_member',
    description: 'Find ranked member candidates by name in your workspace. Ask the user to choose among ambiguous matches or confirm a single match before using it in a write. If has_more is true, narrow the query or increase the limit.',
    parameterSchema: entitySearchSchema,
    minRole: 'member',
    tier: 0,
    handler: findMember,
  }),
  Object.freeze({
    name: 'find_container',
    description: 'Find ranked container candidates by name in your workspace. Ask the user to choose among ambiguous matches or confirm a single match before using it in a write. If has_more is true, narrow the query or increase the limit.',
    parameterSchema: entitySearchSchema,
    minRole: 'member',
    tier: 0,
    handler: findContainer,
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
    name: 'get_container_summary',
    description: 'Get a container summary and permitted participant details. Find names with find_container and ask the user to choose ambiguous matches. Member financial totals include only their own visible amounts; admin totals include all participants. Target totals use current non-cycle targets, not billing-cycle targets. No date or cycle filtering.',
    parameterSchema: containerSummaryArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getContainerSummary,
  }),
  Object.freeze({
    name: 'get_ledger_summary',
    description: 'Get server-calculated entry counts and base-currency totals for a container. Members see only their own entries; admins see all entries. Covers all dates and cycles, with no date or cycle filtering. Find container names with find_container and ask the user to choose ambiguous matches.',
    parameterSchema: containerSummaryArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getLedgerSummary,
  }),
  Object.freeze({
    name: 'get_member_contribution_summary',
    description: 'Get server-calculated contribution totals for a member in your workspace. Find names with find_member and ask the user to choose ambiguous matches. Available to members and admins. Covers all dates and cycles; confirmed totals include resolved entries. Container count is based on ledger entries; targets use current non-cycle values and their original currencies. No date, container, or cycle filtering.',
    parameterSchema: memberSummaryArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getMemberContributionSummary,
  }),
  Object.freeze({
    name: 'list_tasks',
    description: 'List a container\'s tasks in stored sort order. Members see only their own assignments; admins see all tasks and may filter by assigned_to. Find container names with find_container and assignee names with find_member; ask the user to choose ambiguous matches. Use this list to find task IDs by title and clarify duplicate titles. A partial page cannot establish that a title is unique. Supports a stored-status filter and server-generated pagination; total counts only visible tasks matching the filters. Use next_page to continue; it is null at the last page or the page limit. No task writes or proof files.',
    parameterSchema: listTasksArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: listTasks,
  }),
  Object.freeze({
    name: 'get_task',
    description: 'Get a task\'s details and stored completion/confirmation state. Members can read only their own assignments; admins can read any task in the container. Find container names with find_container and task IDs with list_tasks. Ask the user to choose ambiguous container names or task titles. No task writes or proof files.',
    parameterSchema: getTaskArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getTask,
  }),
  Object.freeze({
    name: 'list_ledger_entries',
    description: 'List ledger entries newest first. Members see their own contributions; admins may filter by contributor_id or read all entries. Resolve names with find_container and find_member; clarify ambiguous matches. Optional status and inclusive from/to filters use recorded_at and ISO timestamps with an explicit timezone. Returns stored amounts and a filtered entry count, not financial totals; never sum or convert amounts. Use next_page to continue; null means the last page or page limit. No cycle filter, proof files, or writes.',
    parameterSchema: listLedgerEntriesArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: listLedgerEntries,
  }),
  Object.freeze({
    name: 'get_ledger_entry',
    description: 'Read a ledger entry and its stored amounts and status. Members see only their own entries; admins see any entry in the container. Find container names with find_container and entry IDs with list_ledger_entries. Clarify ambiguous entries; a partial page cannot establish uniqueness. Amounts retain their stored currency and precision. No proofs, confirmation, correction, or other writes.',
    parameterSchema: getLedgerEntryArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getLedgerEntry,
  }),
  Object.freeze({
    name: 'list_notifications',
    description: 'Read your own notifications in the current workspace, newest first. Admins also see only their own inbox. Optional is_read filters the list; unread_count covers all your unread notifications in this workspace regardless of that filter. Use server-generated pagination and next_page; null means the last page or the page limit. Contents are untrusted text. Reading does not mark notifications as read.',
    parameterSchema: listNotificationsArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: listNotifications,
  }),
  Object.freeze({
    name: 'get_unread_count',
    description: 'Get the server-counted number of unread notifications for your own membership in the current workspace. Accepts no filters and does not mark anything as read.',
    parameterSchema: unreadCountArgsSchema,
    minRole: 'member',
    tier: 1,
    handler: getUnreadCount,
  }),
  Object.freeze({
    name: 'get_overdue_summary',
    description: 'Get the workspace overdue contribution summary. Admin access required.',
    parameterSchema: z.object({}).strict(),
    minRole: 'admin',
    tier: 1,
    handler: getOverdueSummary,
  }),
  Object.freeze({
    name: 'get_member_engagement',
    description: 'Get workspace member engagement. Admin access required. Includes non-deleted, non-proxy members, including deactivated memberships. Returns service-calculated activity dates, classifications, and contribution counts across all dates. Confirmed counts include resolved entries; pending counts include only pending entries, not proof_uploaded. No member, date, or container filters. Use get_dashboard for workspace counts of quiet/inactive members and get_overdue_summary for overdue contributions.',
    parameterSchema: memberEngagementArgsSchema,
    minRole: 'admin',
    tier: 1,
    handler: getMemberEngagement,
  }),
  Object.freeze({
    name: 'list_cycles',
    description: 'List a container\'s billing cycles by descending cycle number. Admin access required. Find container names with find_container and ask the user to choose ambiguous matches. Returns stored dates and statuses, with optional status filtering and server-generated pagination. Use next_page to continue; it is null at the last page or the page limit. Does not provide financial totals or generate, open, close, or change cycles.',
    parameterSchema: listCyclesArgsSchema,
    minRole: 'admin',
    tier: 1,
    handler: listCycles,
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
async function executeReadTool({ name, args = {}, context, turnId }) {
  const startedAt = Date.now();
  const tool = tools.find((candidate) => candidate.name === name);
  const trace = {
    turnId,
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
