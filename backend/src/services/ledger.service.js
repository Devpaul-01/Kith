// src/services/ledger.service.js
//
// Preserves the idempotency-key flow, the fail-loud idempotency lookup,
// the duplicate-detection window, the correction-restricted-to-confirmed-
// entries rule, and file verification exactly as designed.

const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError, BusinessRuleError, ConflictError, ForbiddenError } = require('../utils/errors');
const { generateUploadUrl, generateDownloadUrl, verifyUploadedFile } = require('./storage.service');
const notification = require('./notification.service');
const audit        = require('./audit.service');
const { exportLedgerCSV } = require('./export.service');
const logger = require('../utils/logger');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const { getSort } = require('../utils/sorting');

// Defaults to enabled now that the schema confirms the idempotency_key
// column + unique constraint already exist in production.
const IDEMPOTENCY_ENABLED = process.env.IDEMPOTENCY_ENABLED !== 'false';
if (!IDEMPOTENCY_ENABLED) {
  logger.warn('Ledger idempotency-key checking is explicitly DISABLED via IDEMPOTENCY_ENABLED=false.');
}

async function listEntries({ workspaceId, containerId, isAdmin, callerId, query, page, perPage, offset }) {
  let dbQuery = supabaseAdmin
    .from('ledger_entries')
    .select(`
      *, 
      contributor:workspace_members!contributor_id(display_name),
      recorded_by_member:workspace_members!recorded_by(display_name),
      confirmed_by_member:workspace_members!confirmed_by(display_name)
    `, { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('container_id', containerId);

  if (!isAdmin) {
    dbQuery = dbQuery.eq('contributor_id', callerId);
  } else {
    const contributorFilter = query.contributor_id || query['filter[contributor_id]'];
    if (contributorFilter) dbQuery = dbQuery.eq('contributor_id', contributorFilter);
  }

  const statusFilter = query.status || query['filter[status]'];
  if (statusFilter) dbQuery = dbQuery.eq('status', statusFilter);

  const fromDate = query.from;
  const toDate   = query.to;
  if (fromDate) dbQuery = dbQuery.gte('recorded_at', fromDate);
  if (toDate)   dbQuery = dbQuery.lte('recorded_at', toDate);

  const { field: safeSort, ascending } = getSort(query, {
    allowed: ['recorded_at', 'base_amount', 'status', 'original_amount'],
    defaultField: 'recorded_at',
    defaultDescending: true,
  });

  dbQuery = dbQuery.order(safeSort, { ascending }).range(offset, offset + perPage - 1);

  const { data, error, count } = await dbQuery;
  if (error) throw new Error(error.message);

  const entries = (data || []).map((le) => ({
    ...le,
    contributor_name:   le.contributor?.display_name,
    recorded_by_name:   le.recorded_by_member?.display_name,
    confirmed_by_name:  le.confirmed_by_member?.display_name,
    contributor:         undefined,
    recorded_by_member:  undefined,
    confirmed_by_member: undefined,
  }));

  return { entries, count: count || 0 };
}

async function getEntry({ containerId, entryId, isAdmin, callerId }) {
  const { data: entry, error } = await supabaseAdmin
    .from('ledger_entries')
    .select(`
      *,
      contributor:workspace_members!contributor_id(display_name),
      recorded_by_member:workspace_members!recorded_by(display_name),
      confirmed_by_member:workspace_members!confirmed_by(display_name)
    `)
    .eq('id', entryId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  return {
    ...entry,
    contributor_name:   entry.contributor?.display_name,
    recorded_by_name:   entry.recorded_by_member?.display_name,
    confirmed_by_name:  entry.confirmed_by_member?.display_name,
    contributor:         undefined,
    recorded_by_member:  undefined,
    confirmed_by_member: undefined,
  };
}

async function createEntry({ workspaceId, containerId, data, isAdmin, callerId, force, idempotencyKey, actorDisplayName, actorCtx }) {
  if (idempotencyKey && IDEMPOTENCY_ENABLED) {
    const { data: existing, error: idempErr } = await supabaseAdmin
      .from('ledger_entries')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (idempErr) {
      logger.error('Idempotency-key lookup failed', { idempotencyKey, workspaceId, error: idempErr.message });
      throw new Error(idempErr.message);
    }

    if (existing) {
      return { entry: existing, idempotent: true };
    }
  }

  const contributorId = isAdmin ? data.contributor_id : callerId;

  if (isAdmin && !contributorId) {
    throw new BusinessRuleError('Contributor ID is required');
  }

  const { data: participant, error: pErr } = await supabaseAdmin
    .from('container_participants')
    .select('*, workspace_member_id')
    .eq('container_id', containerId)
    .eq('workspace_member_id', contributorId)
    .maybeSingle();

  if (pErr) throw new Error(pErr.message);
  if (!participant) throw new BusinessRuleError('Contributor is not a participant in this container');

  const { data: member, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select('is_proxy')
    .eq('id', participant.workspace_member_id)
    .maybeSingle();

  if (mErr) throw new Error(mErr.message);

  if (member?.is_proxy && !isAdmin) {
    throw new ForbiddenError('Only admins can record contributions for proxy members');
  }

  if (!participant.money_enabled) {
    throw new BusinessRuleError(
      'Money tracking is not enabled for this participant. ' +
      'Enable it from the Participants tab before recording a ledger entry.'
    );
  }

  if (data.cycle_id) {
    const { data: cycle } = await supabaseAdmin
      .from('container_cycles')
      .select('id')
      .eq('id', data.cycle_id)
      .eq('container_id', containerId)
      .maybeSingle();
    if (!cycle) throw new BusinessRuleError('Cycle does not belong to this container');
  }

  if (!force && !(idempotencyKey && IDEMPOTENCY_ENABLED)) {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: dup } = await supabaseAdmin
      .from('ledger_entries')
      .select('id')
      .eq('container_id', containerId)
      .eq('contributor_id', contributorId)
      .eq('original_amount', data.original_amount)
      .gte('recorded_at', tenMinutesAgo)
      .maybeSingle();

    if (dup) throw new ConflictError('Possible duplicate contribution detected within the last 10 minutes. Use ?force=true to override.', { existing_entry_id: dup.id });
  }

  const now    = new Date().toISOString();
  const status = isAdmin ? 'confirmed' : 'pending';

  const { data: entry, error: entryErr } = await supabaseAdmin
    .from('ledger_entries')
    .insert({
      workspace_id:      workspaceId,
      container_id:      containerId,
      cycle_id:          data.cycle_id || null,
      entry_type:        data.entry_type,
      contributor_id:    contributorId,
      original_amount:   data.original_amount,
      original_currency: data.original_currency,
      base_amount:       data.base_amount,
      payment_method:    data.payment_method || null,
      note:              data.note           || null,
      is_crypto:         data.is_crypto      || false,
      idempotency_key:   IDEMPOTENCY_ENABLED ? idempotencyKey : null,
      status,
      recorded_by:       callerId,
      confirmed_at:      status === 'confirmed' ? now : null,
      confirmed_by:      status === 'confirmed' ? callerId : null,
    })
    .select()
    .single();

  if (entryErr) throw new Error(entryErr.message);

  if (member?.is_proxy) {
    await supabaseAdmin.from('proxy_actions').insert({
      workspace_id:    workspaceId,
      proxy_member_id: contributorId,
      managed_by_id:   callerId,
      action_type:     'ledger_entry',
      target_id:       entry.id,
      action_details:  { amount: data.original_amount, currency: data.original_currency },
    });
  }

  if (status === 'pending') {
    const { data: admins } = await supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('role', 'admin')
      .eq('is_active', true);

    await notification.send({
      type:          'contribution_submitted',
      workspaceId,
      recipientIds:  (admins || []).map((a) => a.id),
      referenceType: 'ledger_entry',
      referenceId:   entry.id,
      variables: {
        actor:     actorDisplayName,
        amount:    `${data.original_amount} ${data.original_currency}`,
        container: containerId,
      },
    });
  }

  await audit.log({
    ...actorCtx,
    action:     status === 'confirmed' ? AUDIT_ACTIONS.LEDGER_CONFIRMED : AUDIT_ACTIONS.LEDGER_SUBMITTED,
    targetType: 'ledger_entry',
    targetId:   entry.id,
  });

  return { entry, idempotent: false };
}

async function updateEntry({ containerId, entryId, data, isAdmin, callerId }) {
  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (entry.status !== 'pending') throw new BusinessRuleError('Only pending entries can be edited');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('You can only edit your own entries');
  if (!isAdmin && data.contributor_id !== undefined) throw new ForbiddenError('Only admins can change the contributor');

  const allowedFields = isAdmin
    ? ['original_amount','original_currency','base_amount','payment_method','note','contributor_id']
    : ['original_amount','original_currency','base_amount','payment_method','note'];

  const updates = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) updates[field] = data[field];
  }

  if (!Object.keys(updates).length) return entry;

  const { data: updated, error } = await supabaseAdmin.from('ledger_entries').update(updates).eq('id', entryId).select().single();
  if (error) throw new Error(error.message);

  return updated;
}

async function deleteEntry({ containerId, entryId, isAdmin, callerId, actorCtx }) {
  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('id, status, contributor_id')
    .eq('id', entryId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');

  if (!['pending', 'proof_uploaded'].includes(entry.status)) {
    throw new BusinessRuleError('Only pending or proof-uploaded entries can be deleted. Use corrections to adjust confirmed entries.');
  }

  if (!isAdmin && entry.contributor_id !== callerId) {
    throw new ForbiddenError('You can only delete your own entries');
  }

  const { error: delErr } = await supabaseAdmin
    .from('ledger_entries')
    .delete()
    .eq('id', entryId)
    .eq('container_id', containerId);

  if (delErr) throw new Error(delErr.message);

  await audit.log({
    ...actorCtx,
    action:     AUDIT_ACTIONS.LEDGER_DELETED,
    targetType: 'ledger_entry',
    targetId:   entryId,
  });
}

async function getLedgerSummary({ workspaceId, containerId, isAdmin, callerId }) {
  let query = supabaseAdmin
    .from('ledger_entries')
    .select('status, base_amount')
    .eq('workspace_id', workspaceId)
    .eq('container_id', containerId);

  if (!isAdmin) query = query.eq('contributor_id', callerId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const entries = data || [];

  const confirmed     = entries.filter((e) => e.status === 'confirmed');
  const pending       = entries.filter((e) => e.status === 'pending');
  const proofUploaded = entries.filter((e) => e.status === 'proof_uploaded');
  const disputed      = entries.filter((e) => e.status === 'disputed');

  const sum = (arr) => arr.reduce((s, e) => s + parseFloat(e.base_amount || 0), 0);

  return {
    confirmed_count:        confirmed.length,
    confirmed_base_total:   sum(confirmed),
    pending_count:          pending.length + proofUploaded.length,
    pending_base_total:     sum([...pending, ...proofUploaded]),
    disputed_count:         disputed.length,
    disputed_base_total:    sum(disputed),
    total_count:            entries.length,
    total_base_amount:      sum(entries),
  };
}

async function getUploadProofUrl({ workspaceId, containerId, entryId, isAdmin, callerId, filename, contentType, fileSize }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  return generateUploadUrl({ workspaceId, folder: `proofs/${entryId}`, filename, contentType, fileSize, fileType: 'proof' });
}

async function confirmProof({ workspaceId, containerId, entryId, isAdmin, callerId, filePayload, actorDisplayName }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  // Verify the uploaded file's actual bytes match its declared content
  // type before trusting it as proof.
  await verifyUploadedFile(filePayload.file_path, filePayload.mime_type);

  const fileObject    = { url: filePayload.file_path, name: filePayload.name, size: filePayload.size, mime_type: filePayload.mime_type, uploaded_by: callerId, uploaded_at: new Date().toISOString() };
  const currentProofs = Array.isArray(entry.proofs) ? entry.proofs : [];
  const newStatus     = entry.status === 'pending' ? 'proof_uploaded' : entry.status;

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ proofs: [...currentProofs, fileObject], status: newStatus })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  if (newStatus === 'proof_uploaded') {
    const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true);
    await notification.send({ type: 'contribution_submitted', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'ledger_entry', referenceId: entryId, variables: { actor: actorDisplayName, amount: '', container: containerId } });
  }

  return updated;
}

async function confirmEntry({ workspaceId, containerId, entryId, actorMemberId, actorCtx }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!['pending','proof_uploaded'].includes(entry.status)) throw new BusinessRuleError('Only pending or proof_uploaded entries can be confirmed');

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: actorMemberId })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await notification.send({ type: 'contribution_confirmed', workspaceId, recipientIds: [entry.contributor_id], referenceType: 'ledger_entry', referenceId: entryId, variables: { amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId } });
  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CONFIRMED, targetType: 'ledger_entry', targetId: entryId });

  return updated;
}

// Corrections may only be attached to confirmed entries — non-confirmed
// entries can simply be edited (updateEntry) or deleted (deleteEntry)
// instead.
async function addCorrection({ workspaceId, containerId, entryId, data, actorMemberId, actorCtx }) {
  const { data: source } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!source) throw new NotFoundError('Entry not found');

  if (source.status !== 'confirmed') {
    throw new BusinessRuleError(
      'Only confirmed entries can be corrected. Pending or proof-uploaded entries can be edited or deleted directly instead.'
    );
  }

  const { data: corrParticipant } = await supabaseAdmin
    .from('container_participants')
    .select('money_enabled')
    .eq('container_id', containerId)
    .eq('workspace_member_id', source.contributor_id)
    .maybeSingle();

  if (!corrParticipant?.money_enabled) {
    throw new BusinessRuleError('Cannot add a correction: money tracking is not enabled for this participant.');
  }

  const now = new Date().toISOString();
  const { data: correction, error } = await supabaseAdmin
    .from('ledger_entries')
    .insert({
      workspace_id: workspaceId, container_id: containerId, entry_type: 'correction',
      contributor_id: source.contributor_id, original_amount: data.original_amount,
      original_currency: data.original_currency, base_amount: data.base_amount,
      note: data.note, status: 'confirmed', recorded_by: actorMemberId,
      corrects_entry_id: entryId, confirmed_at: now, confirmed_by: actorMemberId,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.LEDGER_CORRECTED, targetType: 'ledger_entry', targetId: entryId, metadata: { correction_entry_id: correction.id } });

  return correction;
}

async function getProofUrl({ containerId, entryId, fileIndex, isAdmin, callerId }) {
  const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id, proofs').eq('id', entryId).eq('container_id', containerId).maybeSingle();
  if (!entry) throw new NotFoundError('Entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  const proofs = entry.proofs || [];
  if (fileIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${fileIndex}`);

  return generateDownloadUrl(proofs[fileIndex].url, 900);
}

async function deleteProof({ containerId, entryId, proofIndex, isAdmin, callerId }) {
  if (isNaN(proofIndex) || proofIndex < 0) {
    throw new BusinessRuleError('Invalid proof index');
  }

  const { data: entry, error: fetchErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, proofs, status')
    .eq('id', entryId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!entry) throw new NotFoundError('Ledger entry not found');
  if (!isAdmin && entry.contributor_id !== callerId) throw new ForbiddenError('Access denied');

  if (!isAdmin && entry.status === 'confirmed') {
    throw new ForbiddenError('Confirmed entry proofs can only be removed by an admin');
  }

  const proofs = Array.isArray(entry.proofs) ? entry.proofs : [];
  if (proofIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${proofIndex}`);

  const updatedProofs = proofs.filter((_, i) => i !== proofIndex);

  const { data: updated, error } = await supabaseAdmin
    .from('ledger_entries')
    .update({ proofs: updatedProofs })
    .eq('id', entryId)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return updated;
}

async function exportLedger({ workspaceId, containerId, from, to }) {
  return exportLedgerCSV({ workspaceId, containerId, from, to });
}

module.exports = {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  getLedgerSummary,
  getUploadProofUrl,
  confirmProof,
  confirmEntry,
  addCorrection,
  getProofUrl,
  deleteProof,
  exportLedger,
};
