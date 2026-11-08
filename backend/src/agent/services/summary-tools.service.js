const { ValidationError } = require('../../utils/errors');
const { assertAgentContext } = require('./context.service');
const { containerSummaryArgsSchema, memberSummaryArgsSchema } = require('../validators/summary-tools.validator');

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

module.exports = { getContainerSummary, getLedgerSummary, getMemberContributionSummary };
