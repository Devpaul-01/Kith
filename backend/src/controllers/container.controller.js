// src/controllers/container.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const { createContainerSchema, updateContainerSchema, completeContainerSchema, convertToRecurringSchema } = require('../validators/workspace.validator');
const { generatePublicToken } = require('../utils/crypto');
const { generateUploadUrl }   = require('../services/storage.service');
const { uploadFileSchema }    = require('../validators/ledger.validator');
const notification = require('../services/notification.service');
const audit        = require('../services/audit.service');
const { getQueue } = require('../queues');

async function listContainers(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { sort }        = req.query;
    const typeFilter      = req.query['type'];
    const statusFilter    = req.query['status'];

    let query = supabaseAdmin
      .from('containers')
      .select('*, container_participants(id), ledger_entries(base_amount, status)')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);

    if (typeFilter)   query = query.eq('container_type', typeFilter);
    if (statusFilter) query = query.eq('status', statusFilter);

    const dir      = sort?.startsWith('-') ? false : true;
    const field    = sort?.replace('-', '') || 'created_at';
    const safeSort = ['created_at','name','event_date'].includes(field) ? field : 'created_at';
    query = query.order(safeSort, { ascending: dir });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const containers = (data || []).map((c) => {
      const participants       = c.container_participants || [];
      const ledger             = c.ledger_entries || [];
      const totalConfirmedBase = ledger.filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      return { ...c, container_participants: undefined, ledger_entries: undefined, participant_count: participants.length, total_confirmed_base: totalConfirmedBase };
    });

    const activeCount = containers.filter((c) => c.status === 'active').length;
    success(res, { containers, meta: { total: containers.length, active_count: activeCount } });
  } catch (err) { next(err); }
}

async function createContainer(req, res, next) {
  try {
    const data          = createContainerSchema.parse(req.body);
    const { workspaceId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .insert({
        workspace_id: workspaceId, name: data.name, subtitle: data.subtitle || null,
        description: data.description || null, container_type: data.container_type,
        enable_money: data.enable_money, enable_tasks: data.enable_tasks,
        event_date: data.event_date || null, event_type: data.event_type || null,
        event_type_category: data.event_type_category,
        recurrence_cadence: data.recurrence_cadence || null, recurrence_days: data.recurrence_days || null,
        recurrence_start: data.recurrence_start || null, recurrence_end: data.recurrence_end || null,
        carry_forward_unpaid: data.carry_forward_unpaid,
        budget_target: data.budget_target || null, budget_currency: data.budget_currency || null,
        created_by: req.member.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (data.container_type === 'recurring') {
      await getQueue('cycle-generation-queue').add('generate-cycles', { container_id: container.id, generate_months_ahead: 3 }, { attempts: 3 });
    }

    success(res, { container }, 201);
  } catch (err) { next(err); }
}

async function getContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .select('*, container_participants(id)')
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!container) throw new NotFoundError('Container not found');

    const participantCount = (container.container_participants || []).length;

    let currentCycle = null;
    if (container.container_type === 'recurring') {
      const { data: cycle } = await supabaseAdmin
        .from('container_cycles')
        .select('*')
        .eq('container_id', containerId)
        .in('status', ['open','upcoming'])
        .order('cycle_start', { ascending: true })
        .limit(1)
        .maybeSingle();
      currentCycle = cycle || null;
    }

    const { data: participation } = await supabaseAdmin
      .from('container_participants')
      .select('*')
      .eq('container_id', containerId)
      .eq('workspace_member_id', req.member.id)
      .maybeSingle();

    success(res, {
      container: { ...container, container_participants: undefined },
      current_cycle: currentCycle,
      participant_count: participantCount,
      current_user_participation: participation || null,
    });
  } catch (err) { next(err); }
}

async function updateContainer(req, res, next) {
  try {
    const data                          = updateContainerSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!current) throw new NotFoundError('Container not found');

    if (data.enable_money === false && current.enable_money === true) {
      const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId);
      if (count > 0) throw new BusinessRuleError('Cannot disable money tracking — ledger entries exist');
    }

    const allowedFields = ['name','subtitle','description','event_date','event_type','event_type_category','budget_target','budget_currency','public_show_names','carry_forward_unpaid','recurrence_end','enable_tasks','enable_money'];
    const updates       = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (!Object.keys(updates).length) return success(res, { container: current });

    updates.updated_at = new Date().toISOString();

    const { data: container, error } = await supabaseAdmin
      .from('containers').update(updates).eq('id', containerId).select().single();

    if (error) throw new Error(error.message);
    success(res, { container });
  } catch (err) { next(err); }
}

async function completeContainer(req, res, next) {
  try {
    const data                          = completeContainerSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: container, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!container) throw new NotFoundError('Container not found');
    if (container.status !== 'active') throw new BusinessRuleError('Only active containers can be completed');

    const now = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('containers')
      .update({ status: 'completed', completed_at: now, outcome_details: data.outcome_details || null, outcome_files: data.outcome_files, updated_at: now })
      .eq('id', containerId)
      .select()
      .single();

    if (updateErr) throw new Error(updateErr.message);

    // Auto-create milestone
    await supabaseAdmin.from('milestones').insert({
      workspace_id: workspaceId, title: `${container.name} completed`,
      milestone_date: now.split('T')[0], description: data.outcome_details || null,
      milestone_type: 'custom', created_by: req.member.id,
    });

    // Notify participants
    const { data: participants } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id').eq('container_id', containerId);

    await notification.send({ type: 'container_completed', workspaceId, recipientIds: (participants || []).map((p) => p.workspace_member_id), referenceType: 'container', referenceId: containerId, variables: { container: container.name } });

    await audit.log({ ...audit.fromReq(req), action: 'container.completed', targetType: 'container', targetId: containerId });

    success(res, { container: updated });
  } catch (err) { next(err); }
}

async function convertToRecurring(req, res, next) {
  try {
    const data                          = convertToRecurringSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: source, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!source) throw new NotFoundError('Container not found');
    if (source.container_type !== 'event') throw new BusinessRuleError('Only event containers can be converted to recurring');
    if (!['active','completed'].includes(source.status)) throw new BusinessRuleError('Container must be active or completed to convert');

    const { data: newContainer, error: newErr } = await supabaseAdmin
      .from('containers')
      .insert({
        workspace_id: workspaceId, name: data.new_name || source.name, container_type: 'recurring',
        enable_money: source.enable_money, enable_tasks: source.enable_tasks,
        recurrence_cadence: data.recurrence_cadence, recurrence_days: data.recurrence_days || null,
        recurrence_start: data.recurrence_start, recurrence_end: data.recurrence_end || null,
        carry_forward_unpaid: data.carry_forward_unpaid, budget_currency: source.budget_currency,
        converted_from_id: containerId, created_by: req.member.id,
      })
      .select()
      .single();

    if (newErr) throw new Error(newErr.message);

    // Copy participants
    const { data: oldParticipants } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id, money_enabled, tasks_enabled').eq('container_id', containerId);

    if ((oldParticipants || []).length) {
      await supabaseAdmin.from('container_participants').upsert(
        (oldParticipants || []).map((p) => ({ container_id: newContainer.id, workspace_member_id: p.workspace_member_id, money_enabled: p.money_enabled, tasks_enabled: p.tasks_enabled, added_by: req.member.id })),
        { ignoreDuplicates: true }
      );
    }

    await getQueue('cycle-generation-queue').add('generate-cycles', { container_id: newContainer.id, generate_months_ahead: 3 }, { attempts: 3 });

    await audit.log({ ...audit.fromReq(req), action: 'container.converted_to_recurring', targetType: 'container', targetId: newContainer.id, metadata: { source_container_id: containerId } });

    success(res, { new_container: newContainer, source_container_id: containerId }, 201);
  } catch (err) { next(err); }
}

async function archiveContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('containers')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .in('status', ['active','completed'])
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Container not found or cannot be archived');

    await audit.log({ ...audit.fromReq(req), action: 'container.archived', targetType: 'container', targetId: containerId });

    success(res, { container: data });
  } catch (err) { next(err); }
}

async function generatePublicLink(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const token = generatePublicToken();

    const { data, error } = await supabaseAdmin
      .from('containers')
      .update({ public_token: token, updated_at: new Date().toISOString() })
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .select('public_token')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Container not found');

    success(res, { public_url: `${process.env.FRONTEND_URL}/public/event/${token}`, public_token: token });
  } catch (err) { next(err); }
}

async function deleteContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { count } = await supabaseAdmin
      .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId).eq('status', 'confirmed');

    if (count > 0) throw new BusinessRuleError('Cannot delete a container with confirmed ledger entries');

    await supabaseAdmin.from('containers').update({ deleted_at: new Date().toISOString() }).eq('id', containerId).eq('workspace_id', workspaceId);

    await audit.log({ ...audit.fromReq(req), action: 'container.deleted', targetType: 'container', targetId: containerId });

    success(res, { message: 'Container archived.' });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin    = req.member.role === 'admin';
    const callerId   = req.member.id;

    const { data: container, error: cErr } = await supabaseAdmin
      .from('containers').select('id, name, status, budget_target, budget_currency, enable_money').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (cErr) throw new Error(cErr.message);
    if (!container) throw new NotFoundError('Container not found');

    // Participants + targets + ledger (computed in JS)
    const { data: participants } = await supabaseAdmin
      .from('container_participants')
      .select('id, role, money_enabled, workspace_member_id, workspace_members(display_name, is_proxy), contributor_targets(target_amount, target_currency, due_date, is_current, cycle_id)')
      .eq('container_id', containerId);

    const { data: ledger } = await supabaseAdmin
      .from('ledger_entries')
      .select('contributor_id, base_amount, status')
      .eq('container_id', containerId);

    const shapedParticipants = (participants || []).map((p) => {
      const member     = p.workspace_members;
      const currentTarget = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
      const entries    = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id);
      const confirmed  = entries.filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const pending    = entries.filter((le) => ['pending','proof_uploaded'].includes(le.status)).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const target     = parseFloat(currentTarget?.target_amount || 0);
      const outstanding = Math.max(0, target - confirmed);

      let status = 'no_target';
      if (target > 0) {
        if (confirmed >= target) status = 'paid';
        else if (confirmed > 0) status = 'partial';
        else if (currentTarget?.due_date && new Date(currentTarget.due_date) < new Date()) status = 'overdue';
        else status = 'pending';
      }

      const full = {
        member_id: p.workspace_member_id, display_name: member?.display_name, is_proxy: member?.is_proxy,
        role: p.role, status,
        current_target: currentTarget ? { amount: currentTarget.target_amount, currency: currentTarget.target_currency, due_date: currentTarget.due_date } : null,
        confirmed_paid_base: confirmed, pending_paid_base: pending, outstanding_base: outstanding,
      };

      if (!isAdmin && p.workspace_member_id !== callerId) {
        return { member_id: p.workspace_member_id, display_name: member?.display_name, is_proxy: member?.is_proxy, role: p.role, status };
      }
      return full;
    });

    const totalExpected  = shapedParticipants.reduce((s, p) => s + parseFloat(p.current_target?.amount || 0), 0);
    const totalConfirmed = shapedParticipants.reduce((s, p) => s + (p.confirmed_paid_base || 0), 0);
    const totalPending   = shapedParticipants.reduce((s, p) => s + (p.pending_paid_base || 0), 0);
    const progressPct    = totalExpected > 0 ? Math.round((totalConfirmed / totalExpected) * 100) : null;

    success(res, { container, total_expected_base: totalExpected, total_confirmed_base: totalConfirmed, total_pending_base: totalPending, progress_pct: progressPct, participants: shapedParticipants });
  } catch (err) { next(err); }
}

async function listCycles(req, res, next) {
  try {
    const { containerId } = req.params;
    const statusFilter    = req.query['status'];
    const page    = parseInt(req.query.page) || 1;
    const perPage = Math.min(100, parseInt(req.query.per_page) || 20);
    const offset  = (page - 1) * perPage;

    let query = supabaseAdmin.from('container_cycles').select('*', { count: 'exact' }).eq('container_id', containerId).order('cycle_number', { ascending: false }).range(offset, offset + perPage - 1);
    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    success(res, { cycles: data || [], meta: { total: count || 0, pagination: { page, per_page: perPage } } });
  } catch (err) { next(err); }
}

async function generateOutcomeFileUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await generateUploadUrl({ workspaceId, folder: `outcome/${containerId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'outcome_file' });
    success(res, result);
  } catch (err) { next(err); }
}

async function generateCoverPhotoUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await generateUploadUrl({ workspaceId, folder: `covers/${containerId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'cover_photo' });
    success(res, result);
  } catch (err) { next(err); }
}

async function getPublicContainer(req, res, next) {
  try {
    const { publicToken } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .select('*, workspaces!inner(name)')
      .eq('public_token', publicToken)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!container) throw new NotFoundError('Public page not found');

    const { data: ledger } = await supabaseAdmin
      .from('ledger_entries').select('base_amount').eq('container_id', container.id).eq('status', 'confirmed');

    const total       = (ledger || []).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
    const progressPct = container.budget_target ? Math.round((total / container.budget_target) * 100) : null;

    const response = {
      name: container.name, subtitle: container.subtitle, event_date: container.event_date,
      budget_target: container.budget_target, budget_currency: container.budget_currency,
      total_confirmed_base: total, progress_pct: progressPct,
      workspace_name: container.workspaces?.name,
    };

    if (container.public_show_names) {
      const { data: participants } = await supabaseAdmin
        .from('container_participants')
        .select('workspace_member_id, workspace_members(display_name), contributor_targets(target_amount, is_current)')
        .eq('container_id', container.id)
        .eq('exclude_from_public', false)
        .eq('money_enabled', true);

      response.contributors = (participants || []).map((p) => {
        const paidAmount = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
        const target     = parseFloat((p.contributor_targets || []).find((t) => t.is_current)?.target_amount || 0);
        return { display_name: p.workspace_members?.display_name, status: paidAmount >= target ? 'paid' : 'pending' };
      });
    }

    success(res, response);
  } catch (err) { next(err); }
}

module.exports = { listContainers, createContainer, getContainer, updateContainer, completeContainer, convertToRecurring, archiveContainer, generatePublicLink, deleteContainer, getSummary, listCycles, generateOutcomeFileUploadUrl, generateCoverPhotoUploadUrl, getPublicContainer };
