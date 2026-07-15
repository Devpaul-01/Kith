// src/controllers/ledger.controller.js
//
// IDEMPOTENCY KEY — DB MIGRATION REQUIRED
// Before idempotency key checking is active, run:
//
//   ALTER TABLE ledger_entries
//     ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
//     ADD CONSTRAINT ledger_entries_idempotency_key_key UNIQUE (idempotency_key);
//
// Once that migration is applied, clients should send:
//   X-Idempotency-Key: <uuid-per-submission>
// on POST /ledger to guarantee exactly-once recording.
//
// Issue M16 fix: set IDEMPOTENCY_ENABLED=true in the environment once the
// migration above has actually been applied. Until then, the idempotency
// check below is skipped outright (with a one-time startup log) rather
// than probing for a missing column via a try/catch that silently
// swallowed ALL errors — including transient network failures unrelated to
// the migration — with zero observability into how often that happened.

const { supabaseAdmin } = require('../config/supabase');
const { success, paginate } = require('../utils/response');
const { NotFoundError, BusinessRuleError, ConflictError, ForbiddenError } = require('../utils/errors');
const { createLedgerEntrySchema, updateLedgerEntrySchema, uploadFileSchema, confirmProofSchema, addCorrectionSchema } = require('../validators/ledger.validator');
const { generateUploadUrl, generateDownloadUrl, verifyUploadedFile } = require('../services/storage.service');
const notification = require('../services/notification.service');
const audit        = require('../services/audit.service');
const { exportLedgerCSV } = require('../services/export.service');
const logger = require('../utils/logger');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const { getPagination } = require('../utils/pagination');

const IDEMPOTENCY_ENABLED = process.env.IDEMPOTENCY_ENABLED === 'true';
if (!IDEMPOTENCY_ENABLED) {
  logger.warn('Ledger idempotency-key checking is DISABLED (IDEMPOTENCY_ENABLED is not "true"). ' +
    'Set it once the ledger_entries.idempotency_key migration has been applied.');
}

// ── List entries ──────────────────────────────────────────────────

async function listEntries(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin    = req.member.role === 'admin';
    const callerId   = req.member.id;
    const { page, perPage, offset } = getPagination(req.query);

    let query = supabaseAdmin
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
      query = query.eq('contributor_id', callerId);
    } else {
      const contributorFilter = req.query.contributor_id || req.query['filter[contributor_id]'];
      if (contributorFilter) query = query.eq('contributor_id', contributorFilter);
    }

    const statusFilter = req.query.status || req.query['filter[status]'];
    if (statusFilter) query = query.eq('status', statusFilter);

    const fromDate = req.query.from;
    const toDate   = req.query.to;
    if (fromDate) query = query.gte('recorded_at', fromDate);
    if (toDate)   query = query.lte('recorded_at', toDate);

    const sortParam = req.query.sort || '-recorded_at';
    const ascending = !sortParam.startsWith('-');
    const sortField = sortParam.replace('-', '');
    const safeSort  = ['recorded_at', 'base_amount', 'status', 'original_amount'].includes(sortField) ? sortField : 'recorded_at';

    query = query.order(safeSort, { ascending }).range(offset, offset + perPage - 1);

    const { data, error, count } = await query;
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

    paginate(res, { entries }, count || 0, page, perPage);
  } catch (err) { next(err); }
}

// ── Get single entry ────────────────────────────────────────────────
//
// Fetches one ledger entry by id without loading the full list. Respects
// admin/member scoping.

async function getEntry(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

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

    success(res, {
      entry: {
        ...entry,
        contributor_name:   entry.contributor?.display_name,
        recorded_by_name:   entry.recorded_by_member?.display_name,
        confirmed_by_name:  entry.confirmed_by_member?.display_name,
        contributor:         undefined,
        recorded_by_member:  undefined,
        confirmed_by_member: undefined,
      },
    });
  } catch (err) { next(err); }
}

// ── Create entry ──────────────────────────────────────────────────

async function createEntry(req, res, next) {
  try {
    const data = createLedgerEntrySchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const isAdmin     = req.member.role === 'admin';
    const callerId    = req.member.id;
    const force       = req.query.force === 'true';

    // ── Idempotency key check ────────────────────────────────────
    //
    // Issue M16 fix: previously wrapped in a try/catch that swallowed ANY
    // error (network blips, RLS misconfig, timeouts — not just "column
    // doesn't exist yet") with zero logging, silently disabling
    // idempotency protection with no way to know it had happened. Now
    // gated by an explicit IDEMPOTENCY_ENABLED flag (set only once the
    // migration is confirmed applied) instead of probing for the column.
    const idempotencyKey = req.headers['x-idempotency-key'] || null;
    if (idempotencyKey && IDEMPOTENCY_ENABLED) {
      const { data: existing, error: idempErr } = await supabaseAdmin
        .from('ledger_entries')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (idempErr) {
        // Fail loud rather than silently disabling the guarantee this
        // header exists to provide.
        logger.error('Idempotency-key lookup failed', { idempotencyKey, workspaceId, error: idempErr.message });
        throw new Error(idempErr.message);
      }

      if (existing) {
        return success(res, { entry: existing, idempotent: true }, 200);
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
          actor:     req.member.displayName,
          amount:    `${data.original_amount} ${data.original_currency}`,
          container: containerId,
        },
      });
    }

    await audit.log({
      ...audit.fromReq(req),
      action:     status === 'confirmed' ? AUDIT_ACTIONS.LEDGER_CONFIRMED : AUDIT_ACTIONS.LEDGER_SUBMITTED,
      targetType: 'ledger_entry',
      targetId:   entry.id,
    });

    success(res, { entry }, 201);
  } catch (err) { next(err); }
}

// ── Update entry ──────────────────────────────────────────────────

async function updateEntry(req, res, next) {
  try {
    const data                       = updateLedgerEntrySchema.parse(req.body);
    const { containerId, entryId }   = req.params;
    const isAdmin   = req.member.role === 'admin';
    const callerId  = req.member.id;

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

    if (!Object.keys(updates).length) return success(res, { entry });

    const { data: updated, error } = await supabaseAdmin.from('ledger_entries').update(updates).eq('id', entryId).select().single();
    if (error) throw new Error(error.message);

    success(res, { entry: updated });
  } catch (err) { next(err); }
}

// ── Delete entry ──────────────────────────────────────────────────
//
// Only pending/proof_uploaded entries can be deleted. Admins can delete
// any such entry; members can only delete their own. Confirmed entries
// are immutable — use addCorrection instead.

async function deleteEntry(req, res, next) {
  try {
    const { workspaceId, containerId, entryId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

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
      ...audit.fromReq(req),
      action:     AUDIT_ACTIONS.LEDGER_DELETED,
      targetType: 'ledger_entry',
      targetId:   entryId,
    });

    success(res, { message: 'Ledger entry deleted.' });
  } catch (err) { next(err); }
}

// ── Ledger summary ──────────────────────────────────────────────────
//
// Lightweight aggregate endpoint — returns totals by status without
// fetching full entry rows, for dashboard-style aggregate counts.

async function getLedgerSummary(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    let query = supabaseAdmin
      .from('ledger_entries')
      .select('status, base_amount')
      .eq('workspace_id', workspaceId)
      .eq('container_id', containerId);

    if (!isAdmin) query = query.eq('contributor_id', callerId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const entries = data || [];

    const confirmed    = entries.filter((e) => e.status === 'confirmed');
    const pending      = entries.filter((e) => e.status === 'pending');
    const proofUploaded = entries.filter((e) => e.status === 'proof_uploaded');
    const disputed     = entries.filter((e) => e.status === 'disputed');

    const sum = (arr) => arr.reduce((s, e) => s + parseFloat(e.base_amount || 0), 0);

    success(res, {
      summary: {
        confirmed_count:        confirmed.length,
        confirmed_base_total:   sum(confirmed),
        pending_count:          pending.length + proofUploaded.length,
        pending_base_total:     sum([...pending, ...proofUploaded]),
        disputed_count:         disputed.length,
        disputed_base_total:    sum(disputed),
        total_count:            entries.length,
        total_base_amount:      sum(entries),
      },
    });
  } catch (err) { next(err); }
}

// ── Upload proof URL ──────────────────────────────────────────────

async function getUploadProofUrl(req, res, next) {
  try {
    const data                                  = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;
    const isAdmin                               = req.member.role === 'admin';

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Entry not found');
    if (!isAdmin && entry.contributor_id !== req.member.id) throw new ForbiddenError('Access denied');

    const result = await generateUploadUrl({ workspaceId, folder: `proofs/${entryId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'proof' });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Confirm proof ─────────────────────────────────────────────────

async function confirmProof(req, res, next) {
  try {
    const data                                  = confirmProofSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Entry not found');
    if (!isAdmin && entry.contributor_id !== req.member.id) throw new ForbiddenError('Access denied');

    // Issue M13 fix: verify the uploaded file's actual bytes match its
    // declared content type before trusting it as proof.
    await verifyUploadedFile(data.file_path, data.mime_type);

    const fileObject    = { url: data.file_path, name: data.name, size: data.size, mime_type: data.mime_type, uploaded_by: req.member.id, uploaded_at: new Date().toISOString() };
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
      await notification.send({ type: 'contribution_submitted', workspaceId, recipientIds: (admins || []).map((a) => a.id), referenceType: 'ledger_entry', referenceId: entryId, variables: { actor: req.member.displayName, amount: '', container: containerId } });
    }

    success(res, { entry: updated });
  } catch (err) { next(err); }
}

// ── Admin confirm entry ───────────────────────────────────────────

async function confirmEntry(req, res, next) {
  try {
    const { workspaceId, containerId, entryId } = req.params;

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Entry not found');
    if (!['pending','proof_uploaded'].includes(entry.status)) throw new BusinessRuleError('Only pending or proof_uploaded entries can be confirmed');

    const { data: updated, error } = await supabaseAdmin
      .from('ledger_entries')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: req.member.id })
      .eq('id', entryId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await notification.send({ type: 'contribution_confirmed', workspaceId, recipientIds: [entry.contributor_id], referenceType: 'ledger_entry', referenceId: entryId, variables: { amount: `${entry.original_amount} ${entry.original_currency}`, container: containerId } });
    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.LEDGER_CONFIRMED, targetType: 'ledger_entry', targetId: entryId });

    success(res, { entry: updated });
  } catch (err) { next(err); }
}

// ── Add correction ────────────────────────────────────────────────
//
// Issue M5 fix: this previously never checked `source.status`, so a
// correction could be attached to a pending/proof_uploaded/even disputed
// entry — not just confirmed ones. That conflicts with the business model
// implied elsewhere in this file (deleteEntry's own comment: "Confirmed
// entries are immutable (use corrections instead)"), which only makes
// sense if corrections exist specifically to adjust already-confirmed
// entries. Non-confirmed entries can simply be edited (updateEntry) or
// deleted (deleteEntry) instead.

async function addCorrection(req, res, next) {
  try {
    const data                                  = addCorrectionSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const { data: source } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!source) throw new NotFoundError('Entry not found');

    // Issue M5 fix: corrections may only be attached to confirmed entries.
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
        note: data.note, status: 'confirmed', recorded_by: req.member.id,
        corrects_entry_id: entryId, confirmed_at: now, confirmed_by: req.member.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.LEDGER_CORRECTED, targetType: 'ledger_entry', targetId: entryId, metadata: { correction_entry_id: correction.id } });

    success(res, { correction_entry: correction }, 201);
  } catch (err) { next(err); }
}

// ── Proof download URL ────────────────────────────────────────────

async function getProofUrl(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const fileIndex = parseInt(req.query.file_index) || 0;
    const isAdmin   = req.member.role === 'admin';

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('contributor_id, proofs').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Entry not found');
    if (!isAdmin && entry.contributor_id !== req.member.id) throw new ForbiddenError('Access denied');

    const proofs = entry.proofs || [];
    if (fileIndex >= proofs.length) throw new NotFoundError(`No proof file at index ${fileIndex}`);

    const result = await generateDownloadUrl(proofs[fileIndex].url, 900);
    success(res, result);
  } catch (err) { next(err); }
}

// ── Delete proof by index ───────────────────────────────────────────
//
// Removes a specific proof file from a ledger entry's proofs array by
// index. Admin can remove any proof; a member can only remove their own,
// and only from a non-confirmed entry.

async function deleteProof(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const proofIndex = parseInt(req.params.proofIndex, 10);
    const isAdmin    = req.member.role === 'admin';

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
    if (!isAdmin && entry.contributor_id !== req.member.id) throw new ForbiddenError('Access denied');

    // Members can only remove proofs from non-confirmed entries
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

    success(res, { entry: updated });
  } catch (err) { next(err); }
}

// ── Export CSV ────────────────────────────────────────────────────

async function exportLedger(req, res, next) {
  try {
    const { workspaceId }            = req.params;
    const { container_id, from, to } = req.query;

    const csv = await exportLedgerCSV({ workspaceId, containerId: container_id, from, to });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
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
