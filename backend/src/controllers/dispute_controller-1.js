// src/controllers/dispute.controller.js
const { supabaseAdmin } = require('../config/supabase');
const { success }       = require('../utils/response');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const { createDisputeSchema, addDisputeNoteSchema, resolveDisputeSchema } = require('../validators/ledger.validator');
const notification = require('../services/notification.service');
const audit        = require('../services/audit.service');

async function listDisputes(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const statusFilter    = req.query.status;
    const page    = parseInt(req.query.page)     || 1;
    const perPage = Math.min(100, parseInt(req.query.per_page) || 20);
    const offset  = (page - 1) * perPage;

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

    success(res, { disputes }, 200, {
      pagination: { page, per_page: perPage, total: count || 0 },
    });
  } catch (err) { next(err); }
}

async function getDispute(req, res, next) {
  try {
    const { workspaceId, disputeId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    const { data: dispute, error } = await supabaseAdmin
      .from('disputes')
      .select('*, raised_by_member:workspace_members!raised_by(display_name)')
      .eq('id', disputeId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!dispute) throw new NotFoundError('Dispute not found');
    if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

    const { data: entry } = await supabaseAdmin
      .from('ledger_entries')
      .select('*, contributor:workspace_members!contributor_id(display_name)')
      .eq('id', dispute.ledger_entry_id)
      .single();

    success(res, {
      dispute: { ...dispute, raised_by_name: dispute.raised_by_member?.display_name, raised_by_member: undefined },
      entry:   entry ? { ...entry, contributor_name: entry.contributor?.display_name, contributor: undefined } : null,
    });
  } catch (err) { next(err); }
}

async function raiseDispute(req, res, next) {
  try {
    const data                                   = createDisputeSchema.parse(req.body);
    const { workspaceId, containerId, entryId }  = req.params;
    const callerId = req.member.id;
    const isAdmin  = req.member.role === 'admin';

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Ledger entry not found');
    if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('You can only dispute your own entries');
    if (!['confirmed','pending'].includes(entry.status)) throw new BusinessRuleError('Can only dispute confirmed or pending entries');

    const { data: dispute, error } = await supabaseAdmin
      .from('disputes')
      .insert({ workspace_id: workspaceId, ledger_entry_id: entryId, raised_by: callerId, reason: data.reason })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await supabaseAdmin.from('ledger_entries').update({ status: 'disputed' }).eq('id', entryId);

    const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
    await notification.send({ type: 'contribution_disputed', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'dispute', referenceId: dispute.id, variables: { actor: req.member.displayName, amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId } });
    await audit.log({ ...audit.fromReq(req), action: 'dispute.raised', targetType: 'dispute', targetId: dispute.id });

    success(res, { dispute, entry: { ...entry, status: 'disputed' } }, 201);
  } catch (err) { next(err); }
}

async function addDisputeNote(req, res, next) {
  try {
    const data                       = addDisputeNoteSchema.parse(req.body);
    const { workspaceId, disputeId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    const { data: dispute } = await supabaseAdmin.from('disputes').select('*').eq('id', disputeId).eq('workspace_id', workspaceId).maybeSingle();
    if (!dispute) throw new NotFoundError('Dispute not found');
    if (!isAdmin && dispute.raised_by !== callerId) throw new ForbiddenError('Access denied');

    const newNote  = { author_id: callerId, note: data.note, added_at: new Date().toISOString() };
    const newNotes = [...(Array.isArray(dispute.notes) ? dispute.notes : []), newNote];

    const { data: updated, error } = await supabaseAdmin.from('disputes').update({ notes: newNotes }).eq('id', disputeId).select().single();
    if (error) throw new Error(error.message);

    success(res, { dispute: updated });
  } catch (err) { next(err); }
}

async function resolveDispute(req, res, next) {
  try {
    const data                       = resolveDisputeSchema.parse(req.body);
    const { workspaceId, disputeId } = req.params;

    const { data: dispute } = await supabaseAdmin.from('disputes').select('*').eq('id', disputeId).eq('workspace_id', workspaceId).maybeSingle();
    if (!dispute) throw new NotFoundError('Dispute not found');
    if (dispute.status !== 'open') throw new BusinessRuleError('Dispute is already resolved');

    const { data: updated, error } = await supabaseAdmin
      .from('disputes')
      .update({ status: 'resolved', resolution_note: data.resolution_note, resolved_by: req.member.id, resolved_at: new Date().toISOString() })
      .eq('id', disputeId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await supabaseAdmin.from('ledger_entries').update({ status: 'resolved' }).eq('id', dispute.ledger_entry_id);
    await notification.send({ type: 'dispute_resolved', workspaceId, recipientIds: [dispute.raised_by], referenceType: 'dispute', referenceId: disputeId, variables: { container: '' } });
    await audit.log({ ...audit.fromReq(req), action: 'dispute.resolved', targetType: 'dispute', targetId: disputeId });

    success(res, { dispute: updated });
  } catch (err) { next(err); }
}

module.exports = { listDisputes, getDispute, raiseDispute, addDisputeNote, resolveDispute };
