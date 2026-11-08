const { ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { containerSummaryArgsSchema, memberSummaryArgsSchema, memberEngagementArgsSchema } = require('../validators/summary-tools.validator');

function summaryParameters(context, args) {
  // Both handlers require active membership, even without the registry gate.
  assertAgentContext(context);
  const parsed = containerSummaryArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid summary arguments', null, parsed.error.issues);
  // Capture primitives before awaiting a service; model arguments cannot
  // supply identity, permissions, or a different workspace.
  return {
    workspaceId: context.workspace.id,
    containerId: parsed.data.container_id,
    isAdmin: context.member.role === 'admin',
    callerId: context.member.id,
  };
}

async function getContainerSummary({ context, args }) {
  const parameters = summaryParameters(context, args);
  // Load domain services only when selected, not during tool discovery.
  const containerService = require('../../services/container.service');
  return containerService.getSummary(parameters);
}

async function getLedgerSummary({ context, args }) {
  const parameters = summaryParameters(context, args);
  const containerService = require('../../services/container.service');
  const ledgerService = require('../../services/ledger.service');
  // The aggregate alone returns zero for an unknown container. First require
  // a live container in this workspace through the existing service boundary.
  // Discard its broader detail payload; only ledger aggregates reach the model.
  await containerService.getContainer({
    workspaceId: parameters.workspaceId,
    containerId: parameters.containerId,
    callerMemberId: parameters.callerId,
  });
  return ledgerService.getLedgerSummary(parameters);
}

async function getMemberContributionSummary({ context, args }) {
  // Match the member-summary HTTP route: any active workspace member may
  // read a member's summary. No caller-supplied role or workspace is accepted.
  assertAgentContext(context);
  const parsed = memberSummaryArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid summary arguments', null, parsed.error.issues);
  const parameters = {
    workspaceId: context.workspace.id,
    memberId: parsed.data.member_id,
  };
  const isAdmin = context.member.role === 'admin';
  const memberService = require('../../services/member.service');

  // Verify workspace ownership and non-deletion before reading aggregates.
  // Discard profile details; only the service-calculated summary reaches the model.
  await memberService.getMember({ ...parameters, isAdmin });
  return memberService.getContributionSummary(parameters);
}

async function getMemberEngagement({ context, args = {} }) {
  // The member service relies on the HTTP route's admin gate.
  assertAgentContext(context, 'admin');
  const parsed = memberEngagementArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid engagement arguments', null, parsed.error.issues);
  const workspaceId = context.workspace.id;
  const memberService = require('../../services/member.service');
  const members = await memberService.getMemberEngagement({ workspaceId });

  // The legacy service's overdue_count is a hard-coded placeholder. Expose
  // only calculated fields, preserving their values without doing arithmetic.
  return members.map((member) => ({
    member_id: member.member_id,
    display_name: member.display_name,
    last_activity: member.last_activity,
    confirmed_contributions_count: member.confirmed_contributions_count,
    pending_contributions_count: member.pending_contributions_count,
    engagement_level: member.engagement_level,
  }));
}

module.exports = { getContainerSummary, getLedgerSummary, getMemberContributionSummary, getMemberEngagement };
