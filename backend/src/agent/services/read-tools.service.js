const dashboardService = require('../../services/dashboard.service');
const { assertAgentContext } = require('./context.service');
const { AppError, ValidationError } = require('../../utils/errors');
const { getContainerArgsSchema, viewedContainerSchema } = require('../validators/container-tools.validator');

/** Read-only viewport metadata, never a write-target selection or model tool. */
async function getViewedContainerContext({ context, containerId }) {
  assertAgentContext(context);
  const target = getContainerArgsSchema.safeParse({ container_id: containerId });
  if (!target.success) throw new ValidationError('Invalid viewed container');
  const containers = require('../../services/container.service');
  const rows = await containers.getContainer({ workspaceId: context.workspace.id,
    containerId: target.data.container_id, callerMemberId: context.member.id, metadataOnly: true });
  const row = rows?.container;
  const parsed = viewedContainerSchema.safeParse({ workspace_id: context.workspace.id, container_id: row?.id,
    name: row?.name, container_type: row?.container_type, status: row?.status,
    enable_money: row?.enable_money, enable_tasks: row?.enable_tasks });
  if (!parsed.success || parsed.data.container_id !== target.data.container_id
      || (row.workspace_id !== undefined && row.workspace_id !== context.workspace.id)
      || (row.deleted_at !== undefined && row.deleted_at !== null)) {
    throw new AppError('Viewed container information is unavailable.', 503, 'AGENT_CONTEXT_UNAVAILABLE');
  }
  return Object.freeze(parsed.data);
}

async function getMyContext({ context }) {
  assertAgentContext(context);
  const { member, workspace } = context;

  // Whitelist context fields; never return the full middleware objects.
  return {
    member_id: member.id,
    role: member.role,
    display_name: member.displayName,
    is_proxy: member.isProxy,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    base_currency: workspace.baseCurrency,
  };
}

async function getDashboard({ context }) {
  assertAgentContext(context);
  return dashboardService.getDashboardData({
    workspaceId: context.workspace.id,
    isAdmin: context.member.role === 'admin',
    memberId: context.member.id,
  });
}

async function getOverdueSummary({ context }) {
  // The existing service relies on its HTTP route's admin gate.
  assertAgentContext(context, 'admin');
  return dashboardService.getOverdueSummaryData({ workspaceId: context.workspace.id });
}

module.exports = { getMyContext, getViewedContainerContext, getDashboard, getOverdueSummary };
