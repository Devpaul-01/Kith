const { AppError, ForbiddenError, ValidationError } = require('../../utils/errors');
const { normalizeSelfLedgerAmount } = require('../../validators/ledger.validator');
const { assertAgentContext } = require('./context.service');
const { assertCurrentActor } = require('./proposal-actor.service');
const {
  entryConfirmationContextSchema, ledgerConfirmationTargetSchema,
  ledgerConfirmationArgumentsSchema, ledgerConfirmationResultSchema,
  ledgerConfirmationAfter, ledgerConfirmationResultMatches,
  LEDGER_CONFIRMATION_SUMMARY, proposalSchema,
} = require('../validators/proposal.validator');

const confirmLedgerEntryDefinition = Object.freeze({
  name: 'confirm_ledger_entry', tier: 3, minRole: 'admin',
  description: 'Propose admin confirmation of the exact ledger entry explicitly selected for this message. Call with no arguments only when the user requests confirmation of that selection. The full approval card shows the reviewed contributor, amount, currency, note, payment method and pending state, then the confirmed state and authenticated admin. Confirmation time is set on approval. Only pending, proof-free, non-crypto base-currency contributions in active event containers from active non-proxy money-enabled participants are supported. Other entries, corrections, disputes, force overrides and uploads are unavailable. This requests a card; only the separate approval endpoint confirms and locks the financial details.',
  parameterSchema: ledgerConfirmationArgumentsSchema,
});
const definitions = Object.freeze([confirmLedgerEntryDefinition]);
const unavailableSelection = () => new AppError(
  'Contribution information is unavailable. Please try again.', 503, 'AGENT_SELECTION_UNAVAILABLE',
);

function getDefinition(name) {
  return definitions.find((definition) => definition.name === name);
}

function assertSelection(context, selection) {
  assertAgentContext(context, 'admin');
  if (selection.workspace_id !== context.workspace.id
      || selection.actor_member_id !== context.member.id || selection.member_role !== context.member.role) {
    throw new ForbiddenError('Only the current workspace admin can confirm this contribution');
  }
  if (selection.original_currency !== selection.base_currency
      || selection.original_amount !== selection.base_amount) throw unavailableSelection();
}

async function readSelection({ context, containerId, entryId }) {
  assertAgentContext(context, 'admin');
  const target = ledgerConfirmationTargetSchema.safeParse({ container_id: containerId, entry_id: entryId });
  if (!target.success) throw new ValidationError('Invalid ledger entry selection');
  const ledger = require('../../services/ledger.service');
  const raw = await ledger.getEntryConfirmationContext({
    workspaceId: context.workspace.id, containerId: target.data.container_id, entryId: target.data.entry_id,
    callerId: context.member.id, userId: context.userId, isAdmin: context.member.role === 'admin',
  });
  const parsed = entryConfirmationContextSchema.safeParse(raw);
  if (!parsed.success || parsed.data.container_id !== target.data.container_id
      || parsed.data.entry_id !== target.data.entry_id) throw unavailableSelection();
  assertSelection(context, parsed.data);
  return parsed.data;
}

async function selectLedgerEntry({ context, containerId, entryId }) {
  assertAgentContext(context, 'admin');
  await assertCurrentActor(context);
  return Object.freeze(await readSelection({ context, containerId, entryId }));
}

function parseConfirmation(proposal) {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.tool !== confirmLedgerEntryDefinition.name) throw new ValidationError('Invalid ledger confirmation proposal');
  return parsed;
}

async function revalidateSelection({ context, selection }) {
  assertAgentContext(context, 'admin');
  const expected = entryConfirmationContextSchema.parse(selection);
  assertSelection(context, expected);
  let current;
  try {
    current = await readSelection({ context, containerId: expected.container_id, entryId: expected.entry_id });
  } catch (err) {
    if (!['NOT_FOUND', 'FORBIDDEN', 'BUSINESS_RULE_VIOLATION', 'CONFLICT'].includes(err.code)) throw err;
    throw new AppError('Contribution confirmation eligibility changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new AppError('The reviewed contribution changed. Please request a new proposal.', 409, 'AGENT_PROPOSAL_STALE');
  }
}

async function createProposalDraft({ context, tool, selection, args, id, expiresAt }) {
  assertAgentContext(context, 'admin');
  const selected = entryConfirmationContextSchema.safeParse(selection);
  if (!getDefinition(tool) || !selected.success || !ledgerConfirmationArgumentsSchema.safeParse(args).success) {
    throw new ValidationError('An explicitly selected contribution and empty confirmation arguments are required');
  }
  assertSelection(context, selected.data);
  await assertCurrentActor(context);
  await revalidateSelection({ context, selection: selected.data });
  return proposalSchema.parse({
    id, tool, tier: 3, summary: LEDGER_CONFIRMATION_SUMMARY,
    parameters: { container_id: selected.data.container_id, entry_id: selected.data.entry_id },
    before: selected.data, after: ledgerConfirmationAfter(selected.data), expires_at: expiresAt,
  });
}

async function revalidateProposal({ context, proposal }) {
  assertAgentContext(context, 'admin');
  const parsed = parseConfirmation(proposal);
  await revalidateSelection({ context, selection: parsed.before });
}

async function applyProposal({ context, proposal, actorCtx }) {
  assertAgentContext(context, 'admin');
  const parsed = parseConfirmation(proposal);
  assertSelection(context, parsed.before);
  const ledger = require('../../services/ledger.service');
  const entry = await ledger.confirmEntry({
    workspaceId: context.workspace.id, containerId: parsed.parameters.container_id,
    entryId: parsed.parameters.entry_id, actorMemberId: context.member.id,
    actorCtx: {
      workspaceId: context.workspace.id, actorUserId: context.userId, actorMemberId: context.member.id,
      ipAddress: actorCtx?.ipAddress ?? null, userAgent: actorCtx?.userAgent ?? null,
    },
    reviewedConfirmation: { userId: context.userId, isAdmin: context.member.role === 'admin', expected: parsed.before },
  });
  const snapshot = Object.fromEntries(Object.keys(ledgerConfirmationResultSchema.shape)
    .map((field) => [field, field === 'entry_id' ? entry?.id : entry?.[field]]));
  snapshot.original_amount = normalizeSelfLedgerAmount(snapshot.original_amount);
  snapshot.base_amount = normalizeSelfLedgerAmount(snapshot.base_amount);
  const result = ledgerConfirmationResultSchema.safeParse(snapshot);
  if (!result.success || !ledgerConfirmationResultMatches(parsed, result.data)) {
    throw new AppError('The contribution confirmation result could not be verified.', 503, 'AGENT_PROPOSAL_INDETERMINATE');
  }
  return result.data;
}

function getAuditTarget(proposal) {
  return { targetType: 'ledger_entry', targetId: proposal.parameters.entry_id };
}

function getStatusTarget(proposal) {
  return { container_id: proposal.parameters.container_id, entry_id: proposal.parameters.entry_id };
}

module.exports = {
  definitions, confirmLedgerEntryDefinition, getDefinition, selectLedgerEntry,
  createProposalDraft, revalidateProposal, applyProposal, getAuditTarget, getStatusTarget,
};
