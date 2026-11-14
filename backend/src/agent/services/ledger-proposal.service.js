const { z } = require('zod');
const { AppError, BusinessRuleError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { normalizeSelfLedgerAmount, selfLedgerSubmissionDataSchema } = require('../../validators/ledger.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  selfLedgerContextSchema, selfLedgerArgumentsSchema, selfLedgerResultSchema,
  selfLedgerParametersFromArgs, selfLedgerAfter, SELF_LEDGER_SUMMARY, proposalSchema,
} = require('../validators/proposal.validator');

const createLedgerEntryDefinition = Object.freeze({
  name: 'create_ledger_entry', tier: 2, minRole: 'member',
  description: 'Propose submitting your own contribution to the active event container explicitly selected for this message. Provide the requested amount as plain positive decimal text with at most two decimal places and the selected container\'s base currency. Optional payment_method is cash, bank_transfer, mobile_money or other; optional note contains only the user\'s requested note. Contributor, container, base amount, status and idempotency are server-controlled. Submissions stay pending for admin review, including for admins. Foreign currency, recurring cycles, expenses, crypto, proxies, force overrides and proof uploads are unavailable. This creates an approval card; only the separate approval endpoint submits the entry.',
  parameterSchema: selfLedgerArgumentsSchema,
});
const definitions = Object.freeze([createLedgerEntryDefinition]);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

function assertSelfSelection(context, selection) {
  assertAgentContext(context);
  if (selection.workspace_id !== context.workspace.id
      || selection.contributor_id !== context.member.id || selection.member_role !== context.member.role) {
    throw new ForbiddenError('You can only submit your own contributions in the current workspace');
  }
}

async function readSelection({ context, containerId }) {
  assertAgentContext(context);
  const id = z.string().uuid().safeParse(containerId);
  if (!id.success) throw new ValidationError('Invalid ledger container selection');
  const normalizedId = id.data.toLowerCase();
  const ledger = require('../../services/ledger.service');
  const raw = await ledger.getSelfSubmissionContext({
    workspaceId: context.workspace.id, containerId: normalizedId,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  });
  const parsed = selfLedgerContextSchema.safeParse(raw);
  if (!parsed.success || parsed.data.container_id !== normalizedId) {
    throw new AppError('Contribution information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE');
  }
  assertSelfSelection(context, parsed.data);
  return parsed.data;
}

async function selectLedgerContainer({ context, containerId }) {
  await assertCurrentActor(context);
  return Object.freeze(await readSelection({ context, containerId }));
}

function parseLedgerProposal(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== createLedgerEntryDefinition.name) throw new ValidationError('Invalid ledger proposal');
  return parsed;
}

async function revalidateOne({ context, selection }) {
  const expected = selfLedgerContextSchema.parse(selection);
  assertSelfSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Contribution eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The selected container or contribution currency changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  const selected = selfLedgerContextSchema.safeParse(selection);
  const requested = selfLedgerArgumentsSchema.safeParse(args);
  if (!getDefinition(tool) || !selected.success || !requested.success) {
    throw new ValidationError('An explicitly selected container and valid contribution arguments are required');
  }
  assertSelfSelection(context, selected.data);
  if (requested.data.currency !== selected.data.base_currency) {
    throw new BusinessRuleError('This tool only supports contributions in the workspace base currency');
  }
  await assertCurrentActor(context);
  await revalidateOne({ context, selection: selected.data });
  const parameters = selfLedgerParametersFromArgs(selected.data, requested.data);
  return proposalSchema.parse({
    id, tool, tier: 2, summary: SELF_LEDGER_SUMMARY, parameters,
    before: selected.data, after: selfLedgerAfter(parameters), expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  const parsed = parseLedgerProposal(proposal);
  await revalidateOne({ context, selection: parsed.before });
}

async function applyProposal({ context, proposal, actorCtx }) {
  const parsed = parseLedgerProposal(proposal);
  assertSelfSelection(context, parsed.before);
  const { container_id: containerId, ...parameters } = parsed.parameters;
  const data = selfLedgerSubmissionDataSchema.parse(parameters);
  const idempotencyKey = `agent:${parsed.id}`;
  const ledger = require('../../services/ledger.service');
  const raw = await ledger.createEntry({
    workspaceId: context.workspace.id, containerId, data,
    isAdmin: context.member.role === 'admin', callerId: context.member.id,
    force: false, idempotencyKey, actorDisplayName: context.member.displayName,
    actorCtx: {
      workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    },
    selfSubmission: { userId: context.userId, expected: parsed.before },
  });
  const entry = raw?.entry;
  const result = selfLedgerResultSchema.safeParse({
    entry_id: entry?.id, container_id: entry?.container_id, contributor_id: entry?.contributor_id,
    entry_type: entry?.entry_type, original_amount: normalizeSelfLedgerAmount(entry?.original_amount),
    original_currency: entry?.original_currency, base_amount: normalizeSelfLedgerAmount(entry?.base_amount),
    payment_method: entry?.payment_method, note: entry?.note, cycle_id: entry?.cycle_id,
    is_crypto: entry?.is_crypto, status: entry?.status,
    confirmed_at: entry?.confirmed_at, confirmed_by: entry?.confirmed_by, recorded_at: entry?.recorded_at,
  });
  if (!result.success || entry.workspace_id !== context.workspace.id
      || entry.recorded_by !== context.member.id || entry.idempotency_key !== idempotencyKey
      || entry.corrects_entry_id !== null) {
    throw new AppError('The contribution result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  const { entry_id, recorded_at, ...after } = result.data;
  if (JSON.stringify(after) !== JSON.stringify(parsed.after)) {
    throw new AppError('The contribution result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal, context, result) {
  return result
    ? { targetType: 'ledger_entry', targetId: result.entry_id }
    : { targetType: 'container', targetId: proposal.parameters.container_id };
}

function getStatusTarget(proposal) {
  return { container_id: proposal.parameters.container_id, contributor_id: proposal.parameters.contributor_id };
}

module.exports = {
  definitions, createLedgerEntryDefinition, getDefinition, selectLedgerContainer,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
