// src/services/dispute.service.js
//
// Extracted from dispute.controller.js as part of the service-layer
// refactor. Preserves the atomic RPC usage for raise/resolve (issue H1-
// class fixes) and the 404-not-500 fix on the entry lookup (issue L4).

const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const notification = require('./notification.service');
const audit        = require('./audit.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');

async function listDisputes({ workspaceId, statusFilter, page, perPage, offset }) {
  let query = supabaseAdmin
    .from('disputes')
    .select(`
      *, ledger_entries!ledger_entry_id(original_amount, original_currency, base_amount, status),
      raised_by_member:workspace_members!raised_by(display_name),
      resolved_by_member:workspace_members!resolved_by(display_name)
    `, { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('raised_at', { ascending: false })
    .range(offset, offset + perPage - 1);

  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const disputes = (data || []).map((d) => ({
    ...d,
    original_amount:   d.ledger_entries?.original_amount,
    original_currency: d.ledger_entries?.original_currency,
    base_amount:       d.ledger_entries?.base_amount,
    entry_status:      d.ledger_entries?.status,
    raised_by_name:    d.raised_by_member?.display_name,
    resolved_by_name:  d.resolved_by_member?.display_name,
    ledger_entries: undefined, raised_by_member: undefined, resolved_by_member: undefined,
  }));

  return { disputes, count: count || 0 };
}

async function getDispute({ workspaceId, disputeId, isAdmin, callerId }) {
  const { data: dispute, error } = await supabaseAdmin
    .from('disputes')
    .select('*, raised_by_member:workspace_members!raised_by(display_name)')
    .eq('id', disputeId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

  // Issue L4 fix: .maybeSingle() + explicit 404 instead of .single(),
  // which threw a raw Postgrest error on a missing referenced entry.
  const { data: entry, error: entryErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('*, contributor:workspace_members!contributor_id(display_name)')
    .eq('id', dispute.ledger_entry_id)
    .maybeSingle();

  if (entryErr) throw new Error(entryErr.message);

  return {
    dispute: { ...dispute, raised_by_name: dispute.raised_by_member?.display_name, raised_by_member: undefined },
    entry:   entry ? { ...entry, contributor_name: entry.contributor?.display_name, contributor: undefined } : null,
  };
}

// raise_dispute_atomic inserts the dispute row and updates the ledger
// entry's status inside one Postgres transaction — see the RPC comment
// in the original controller for the failure mode this prevents.
async function raiseDispute({ workspaceId, containerId, entryId, reason, callerId, isAdmin, actorDisplayName, actorCtx }) {
  const { data: entry } = await supabaseAdmin
    .from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('You can only dispute your own entries');
  if (!['confirmed', 'pending'].includes(entry.status)) throw new BusinessRuleError('Can only dispute confirmed or pending entries');

  const { data: disputeData, error: rpcErr } = await supabaseAdmin.rpc('raise_dispute_atomic', {
    p_workspace_id:    workspaceId,
    p_ledger_entry_id: entryId,
    p_raised_by:       callerId,
    p_reason:          reason,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  const dispute = disputeData;

  const { data: admins } = await supabaseAdmin
    .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);

  await notification.send({
    type:          'contribution_disputed',
    workspaceId,
    recipientIds:  (admins || []).map((a) => a.id),
    referenceType: 'dispute',
    referenceId:   dispute.id,
    variables:     { actor: actorDisplayName, amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId },
  });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RAISED, targetType: 'dispute', targetId: dispute.id });

  return { dispute, entry: { ...entry, status: 'disputed' } };
}

async function addDisputeNote({ workspaceId, disputeId, note, isAdmin, callerId }) {
  const { data: dispute } = await supabaseAdmin
    .from('disputes').select('*').eq('id', disputeId).eq('workspace_id', workspaceId).maybeSingle();
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

  const newNote  = { author_id: callerId, note, added_at: new Date().toISOString() };
  const newNotes = [...(Array.isArray(dispute.notes) ? dispute.notes : []), newNote];

  const { data: updated, error } = await supabaseAdmin
    .from('disputes').update({ notes: newNotes }).eq('id', disputeId).select().single();
  if (error) throw new Error(error.message);

  return updated;
}

// resolve_dispute_atomic updates the dispute and the ledger entry's
// status inside one Postgres transaction.
async function resolveDispute({ workspaceId, disputeId, resolutionNote, resolvedByMemberId, actorCtx }) {
  const { data: dispute } = await supabaseAdmin
    .from('disputes')
    .select('*, ledger_entries!ledger_entry_id(container_id, containers!container_id(name))')
    .eq('id', disputeId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!dispute) throw new NotFoundError('Dispute not found');
  if (dispute.status !== 'open') throw new BusinessRuleError('Dispute is already resolved');

  const containerName = dispute.ledger_entries?.containers?.name || 'a container';

  const now = new Date().toISOString();
  const { data: updatedData, error: rpcErr } = await supabaseAdmin.rpc('resolve_dispute_atomic', {
    p_dispute_id:      disputeId,
    p_resolution_note: resolutionNote,
    p_resolved_by:     resolvedByMemberId,
    p_resolved_at:     now,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  const updated = updatedData;

  await notification.send({
    type:          'dispute_resolved',
    workspaceId,
    recipientIds:  [dispute.raised_by],
    referenceType: 'dispute',
    referenceId:   disputeId,
    variables:     { container: containerName },
  });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.DISPUTE_RESOLVED, targetType: 'dispute', targetId: disputeId });

  return updated;
}

module.exports = { listDisputes, getDispute, raiseDispute, addDisputeNote, resolveDispute };
