const { ForbiddenError, ValidationError } = require('../../utils/errors');
const { getPagination, getPaginationMeta } = require('../../utils/pagination');
const { assertAgentContext } = require('./context.service');
const { listDisputesArgsSchema, getDisputeArgsSchema, MAX_DISPUTE_PAGE } = require('../validators/dispute-tools.validator');

const DISPUTE_FIELDS = Object.freeze([
  'id', 'ledger_entry_id', 'raised_by', 'raised_by_name', 'reason', 'status', 'resolution_note', 'resolved_by',
  'resolved_by_name', 'raised_at', 'resolved_at',
]);
const ENTRY_FIELDS = Object.freeze([
  'id', 'container_id', 'cycle_id', 'entry_type', 'contributor_id', 'contributor_name', 'original_amount',
  'original_currency', 'base_amount', 'is_crypto', 'payment_method', 'status', 'note', 'corrects_entry_id',
  'recorded_at', 'confirmed_at',
]);
const LIST_FIELDS = Object.freeze([...DISPUTE_FIELDS, 'original_amount', 'original_currency', 'base_amount', 'entry_status']);
const fieldsFrom = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
function pageMeta(count, page, perPage) {
  const pagination = getPaginationMeta({ total: count, page, perPage });
  return { ...pagination, next_page: page < pagination.total_pages && page < MAX_DISPUTE_PAGE ? page + 1 : null };
}

async function listDisputes({ context, args }) {
  assertAgentContext(context, 'admin');
  const parsed = listDisputesArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid dispute arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const parameters = { workspaceId: context.workspace.id, statusFilter: parsed.data.status, page, perPage, offset, metadataOnly: true };
  const baseCurrency = context.workspace.baseCurrency;
  const disputeService = require('../../services/dispute.service');
  const { disputes, count } = await disputeService.listDisputes(parameters);
  return { disputes: disputes.map((dispute) => fieldsFrom(dispute, LIST_FIELDS)), base_currency: baseCurrency, pagination: pageMeta(count, page, perPage) };
}

async function getDispute({ context, args }) {
  assertAgentContext(context);
  const parsed = getDisputeArgsSchema.safeParse(args);
  if (!parsed.success) throw new ValidationError('Invalid dispute arguments', null, parsed.error.issues);
  const { page, perPage, offset } = getPagination(parsed.data);
  const workspaceId = context.workspace.id;
  const callerId = context.member.id;
  const isAdmin = context.member.role === 'admin';
  const baseCurrency = context.workspace.baseCurrency;
  const disputeService = require('../../services/dispute.service');
  const { dispute, entry, notesCount } = await disputeService.getDispute({
    workspaceId, disputeId: parsed.data.dispute_id, isAdmin, callerId, notesPagination: { page, perPage, offset },
  });
  if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('You can only view disputes you raised');
  return {
    dispute: { ...fieldsFrom(dispute, DISPUTE_FIELDS), notes: dispute.notes.map((note) => fieldsFrom(note, ['author_id', 'note', 'added_at'])) },
    entry: entry ? fieldsFrom(entry, ENTRY_FIELDS) : null,
    base_currency: baseCurrency, notes_pagination: pageMeta(notesCount, page, perPage),
  };
}

module.exports = { listDisputes, getDispute };
