const dashboardService = require('../../services/dashboard.service');
const { assertAgentContext } = require('./context.service');

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

module.exports = { getMyContext, getDashboard, getOverdueSummary };
