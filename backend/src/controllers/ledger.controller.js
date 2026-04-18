// src/controllers/ledger.controller.js
const { supabaseAdmin } = require('../config/supabase');
const { success }       = require('../utils/response');
const { NotFoundError, BusinessRuleError, ConflictError, ForbiddenError } = require('../utils/errors');
const { createLedgerEntrySchema, updateLedgerEntrySchema, uploadFileSchema, confirmProofSchema, addCorrectionSchema } = require('../validators/ledger.validator');
const { generateUploadUrl, generateDownloadUrl } = require('../services/storage.service');
const notification = require('../services/notification.service');
const audit        = require('../services/audit.service');
const { exportLedgerCSV } = require('../services/export.service');

// ── List entries ──────────────────────────────────────────────────

async function listEntries(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin    = req.member.role === 'admin';
    const callerId   = req.member.id;
    const page       = parseInt(req.query.page) || 1;
    const perPage    = Math.min(100, parseInt(req.query.per_page) || 20);
    const offset     = (page - 1) * perPage;

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

    // ✅ FIX: Apply filters correctly
    if (!isAdmin) {
      // Non-admins can only see their own entries
      query = query.eq('contributor_id', callerId);
    } else {
      // Admins can filter by contributor_id if provided
      const contributorFilter = req.query.contributor_id || req.query['filter[contributor_id]'];
      if (contributorFilter) {
        query = query.eq('contributor_id', contributorFilter);
      }
    }

    // ✅ Status filter (works for both admin and non-admin)
    const statusFilter = req.query.status || req.query['filter[status]'];
    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    // ✅ Date range filter (optional - add this if you need it)
    const fromDate = req.query.from;
    const toDate = req.query.to;
    if (fromDate) {
      query = query.gte('recorded_at', fromDate);
    }
    if (toDate) {
      query = query.lte('recorded_at', toDate);
    }

    // Sort
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
      contributor: undefined, 
      recorded_by_member: undefined, 
      confirmed_by_member: undefined,
    }));

    success(res, { entries }, 200, { 
      pagination: { 
        page, 
        per_page: perPage, 
        total: count || 0 
      } 
    });
  } catch (err) { 
    next(err); 
  }
}

// ── Create entry ──────────────────────────────────────────────────

async function createEntry(req, res, next) {
  try {
    const data = createLedgerEntrySchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const isAdmin = req.member.role === 'admin';
    const callerId = req.member.id;
    const force = req.query.force === 'true';

    // 🔒 SECURITY: Non-admins ALWAYS contribute as themselves
    // Ignore whatever they sent in the request body
    const contributorId = isAdmin ? data.contributor_id : callerId;

    // Validate that contributor_id exists (for admins)
    if (isAdmin && !contributorId) {
      throw new BusinessRuleError('Contributor ID is required');
    }

    // Get participant (using the determined contributorId)
    const { data: participant, error: pErr } = await supabaseAdmin
      .from('container_participants')
      .select('*, workspace_member_id')
      .eq('container_id', containerId)
      .eq('workspace_member_id', contributorId)
      .maybeSingle();

    if (pErr) throw new Error(pErr.message);
    if (!participant) throw new BusinessRuleError('Contributor is not a participant in this container');

    // Get member details separately
    const { data: member, error: mErr } = await supabaseAdmin
      .from('workspace_members')
      .select('is_proxy')
      .eq('id', participant.workspace_member_id)
      .maybeSingle();

    if (mErr) throw new Error(mErr.message);

    // Check proxy restriction
    if (member?.is_proxy && !isAdmin) {
      throw new ForbiddenError('Only admins can record contributions for proxy members');
    }

    // Check money tracking is enabled
    if (!participant.money_enabled) {
      throw new BusinessRuleError(
        'Money tracking is not enabled for this participant. ' +
        'Enable it from the Participants tab before recording a ledger entry.'
      );
    }

    // Check cycle if provided
    if (data.cycle_id) {
      const { data: cycle } = await supabaseAdmin
        .from('container_cycles')
        .select('id')
        .eq('id', data.cycle_id)
        .eq('container_id', containerId)
        .maybeSingle();
      if (!cycle) throw new BusinessRuleError('Cycle does not belong to this container');
    }

    // Check for duplicates
    if (!force) {
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

    // Create the ledger entry
    const now = new Date().toISOString();
    const status = isAdmin ? 'confirmed' : 'pending';

    const { data: entry, error: entryErr } = await supabaseAdmin
      .from('ledger_entries')
      .insert({
        workspace_id: workspaceId,
        container_id: containerId,
        cycle_id: data.cycle_id || null,
        entry_type: data.entry_type,
        contributor_id: contributorId,  // ← Use the determined ID
        original_amount: data.original_amount,
        original_currency: data.original_currency,
        base_amount: data.base_amount,
        payment_method: data.payment_method || null,
        note: data.note || null,
        is_crypto: data.is_crypto || false,
        status,
        recorded_by: callerId,
        confirmed_at: status === 'confirmed' ? now : null,
        confirmed_by: status === 'confirmed' ? callerId : null,
      })
      .select()
      .single();

    if (entryErr) throw new Error(entryErr.message);

    // Log proxy action
    if (member?.is_proxy) {
      await supabaseAdmin.from('proxy_actions').insert({
        workspace_id: workspaceId,
        proxy_member_id: contributorId,
        managed_by_id: callerId,
        action_type: 'ledger_entry',
        target_id: entry.id,
        action_details: { amount: data.original_amount, currency: data.original_currency },
      });
    }

    // Send notifications for pending entries
    if (status === 'pending') {
      const { data: admins } = await supabaseAdmin
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('role', 'admin')
        .eq('is_active', true);

      await notification.send({
        type: 'contribution_submitted',
        workspaceId,
        recipientIds: (admins || []).map((a) => a.id),
        referenceType: 'ledger_entry',
        referenceId: entry.id,
        variables: {
          actor: req.member.displayName,
          amount: `${data.original_amount} ${data.original_currency}`,
          container: containerId
        }
      });
    }

    await audit.log({
      ...audit.fromReq(req),
      action: status === 'confirmed' ? 'ledger.confirmed' : 'ledger.submitted',
      targetType: 'ledger_entry',
      targetId: entry.id
    });

    success(res, { entry }, 201);
  } catch (err) {
    next(err);
  }
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

// ── Confirm proof ──────────────────────────────────────────────────

async function confirmProof(req, res, next) {
  try {
    const data                                  = confirmProofSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const { data: entry } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!entry) throw new NotFoundError('Entry not found');
    if (!isAdmin && entry.contributor_id !== req.member.id) throw new ForbiddenError('Access denied');

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

// ── Admin confirm entry ────────────────────────────────────────────

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
    await audit.log({ ...audit.fromReq(req), action: 'ledger.confirmed', targetType: 'ledger_entry', targetId: entryId });

    success(res, { entry: updated });
  } catch (err) { next(err); }
}

// ── Add correction ────────────────────────────────────────────────

async function addCorrection(req, res, next) {
  try {
    const data                                  = addCorrectionSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const { data: source } = await supabaseAdmin.from('ledger_entries').select('*').eq('id', entryId).eq('container_id', containerId).maybeSingle();
    if (!source) throw new NotFoundError('Entry not found');


    // ✅ NEW: verify money is still enabled for the contributor
    const { data: corrParticipant } = await supabaseAdmin
      .from('container_participants')
      .select('money_enabled')
      .eq('container_id', containerId)
      .eq('workspace_member_id', source.contributor_id)
      .maybeSingle();

    if (!corrParticipant?.money_enabled) {
      throw new BusinessRuleError(
        'Cannot add a correction: money tracking is not enabled for this participant.',
      );
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

    await audit.log({ ...audit.fromReq(req), action: 'ledger.corrected', targetType: 'ledger_entry', targetId: entryId, metadata: { correction_entry_id: correction.id } });

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

// ── Export CSV ────────────────────────────────────────────────────

async function exportLedger(req, res, next) {
  try {
    const { workspaceId }              = req.params;
    const { container_id, from, to }   = req.query;

    const csv = await exportLedgerCSV({ workspaceId, containerId: container_id, from, to });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

module.exports = { listEntries, createEntry, updateEntry, getUploadProofUrl, confirmProof, confirmEntry, addCorrection, getProofUrl, exportLedger };
