const { ForbiddenError, ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listLedgerEntriesArgsSchema, getLedgerEntryArgsSchema, MAX_LEDGER_PAGE } = require('../validators/ledger-tools.validator');

function entryResult(entry) {
  // Preserve stored money exactly. Proof paths and idempotency keys are internal.
  return {
    id: entry.id,
    container_id: entry.container_id,
    cycle_id: entry.cycle_id,
    entry_type: entry.entry_type,
    contributor_id: entry.contributor_id,
    contributor_name: entry.contributor_name,
    original_amount: entry.original_amount,
    original_currency: entry.original_currency,
    base_amount: entry.base_amount,
    is_crypto: entry.is_crypto,
    payment_method: entry.payment_method,
    status: entry.status,
    note: entry.note,
    corrects_entry_id: entry.corrects_entry_id,
    recorded_at: entry.recorded_at,
    confirmed_at: entry.confirmed_at,
  };
}

async function listLedgerEntries({ context, args }) {
  assertAgentContext(context);
  const parsed = listLedgerEntriesArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid ledger arguments', null, parsed.error.issues);
  const workspaceId = context.workspace.id;
  const callerId = context.member.id;
  const isAdmin = context.member.role === 'admin';
  const baseCurrency = context.workspace.baseCurrency;
  if (!isAdmin && parsed.data.contributor_id && parsed.data.contributor_id !== callerId) {
    throw new ForbiddenError('You can only view your own ledger entries');
  }
  const { container_id, contributor_id, status, from, to } = parsed.data;
  const { page, perPage, offset } = getPagination(parsed.data);
  const ledgerService = require('../../services/ledger.service');
  const { entries, count } = await ledgerService.listEntries({
    workspaceId, containerId: container_id, isAdmin, callerId,
    query: { contributor_id, status, from, to }, page, perPage, offset,
  });
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return {
    entries: entries.map(entryResult),
    base_currency: baseCurrency,
    pagination: { ...pagination, next_page: page < pagination.total_pages && page < MAX_LEDGER_PAGE ? page + 1 : null },
  };
}

async function getLedgerEntry({ context, args }) {
  assertAgentContext(context);
  const parsed = getLedgerEntryArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid ledger arguments', null, parsed.error.issues);
  const parameters = {
    workspaceId: context.workspace.id, callerId: context.member.id,
    isAdmin: context.member.role === 'admin',
    containerId: parsed.data.container_id, entryId: parsed.data.entry_id,
  };
  const baseCurrency = context.workspace.baseCurrency;
  const ledgerService = require('../../services/ledger.service');
  const entry = await ledgerService.getEntry(parameters);
  return { entry: entryResult(entry), base_currency: baseCurrency };
}

module.exports = { listLedgerEntries, getLedgerEntry };
