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
const logger       = require('../utils/logger');

// ── List containers ────────────────────────────────────────────────
//
// Issue 9 confirmation: ledger_entries join is present and correct.
// No change required — the original code already joins ledger_entries.

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
    const safeSort = ['created_at', 'name', 'event_date'].includes(field) ? field : 'created_at';
    query = query.order(safeSort, { ascending: dir });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const containers = (data || []).map((c) => {
      const participants       = c.container_participants || [];
      const ledger             = c.ledger_entries        || [];
      const totalConfirmedBase = ledger
        .filter((le) => le.status === 'confirmed')
        .reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      return {
        ...c,
        container_participants: undefined,
        ledger_entries:         undefined,
        participant_count:      participants.length,
        total_confirmed_base:   totalConfirmedBase,
      };
    });

    const activeCount = containers.filter((c) => c.status === 'active').length;
    success(res, { containers, meta: { total: containers.length, active_count: activeCount } });
  } catch (err) { next(err); }
}

async function createContainer(req, res, next) {
  try {
    const data            = createContainerSchema.parse(req.body);
    const { workspaceId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .insert({
        workspace_id:         workspaceId,
        name:                 data.name,
        subtitle:             data.subtitle             || null,
        description:          data.description          || null,
        container_type:       data.container_type,
        enable_money:         data.enable_money         ?? false,
        enable_tasks:         data.enable_tasks         ?? false,
        event_date:           data.event_date           || null,
        event_type:           data.event_type           || null,
        event_type_category:  data.event_type_category  || 'other',
        recurrence_cadence:   data.recurrence_cadence   || null,
        recurrence_days:      data.recurrence_days      || null,
        recurrence_start:     data.recurrence_start     || null,
        recurrence_end:       data.recurrence_end       || null,
        carry_forward_unpaid: data.carry_forward_unpaid ?? false,
        budget_target:        data.budget_target        || null,
        budget_currency:      data.budget_currency      || null,
        created_by:           req.member.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (container.container_type === 'recurring') {
      try {
        await getQueue('cycle-generation-queue').add(
          'generate-cycles',
          { container_id: container.id, generate_months_ahead: 3 },
          { attempts: 3 }
        );
      } catch (queueErr) {
        // The container row already exists at this point — a queue outage
        // shouldn't turn a successful create into a 500 for the client.
        // Cycle generation also runs on a daily maintenance schedule
        // (see queues/scheduler.js: 'cycle-gen-maintenance'), so a missed
        // enqueue here is self-healing rather than silently lost forever.
        logger.error('Failed to enqueue initial cycle generation — will be picked up by daily maintenance job', {
          containerId: container.id,
          error: queueErr.message,
        });
      }
    }

    success(res, { container }, 201);
  } catch (err) { next(err); }
}

async function getContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data: container, error } = await supabaseAdmin
      .from('containers')
      .select(`
        id, workspace_id, name, subtitle, description,
        container_type, status, enable_money, enable_tasks,
        event_date, event_type, event_type_category,
        budget_target, budget_currency,
        recurrence_cadence, recurrence_days, recurrence_start, recurrence_end,
        carry_forward_unpaid, auto_generate_cycles,
        public_token, public_show_names,
        outcome_details, outcome_files, converted_from_id,
        created_by, created_at, updated_at, completed_at, deleted_at,
        container_participants(id)
      `)
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
        .in('status', ['open', 'upcoming'])
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

    const { container_participants, ...cleanContainer } = container;

    success(res, {
      container:                  cleanContainer,
      current_cycle:              currentCycle,
      tasks_enabled:              container.enable_tasks,
      money_enabled:              container.enable_money,
      participant_count:          participantCount,
      current_user_participation: participation || null,
    });
  } catch (err) { next(err); }
}

async function updateContainer(req, res, next) {
  try {
    const data                         = updateContainerSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!current) throw new NotFoundError('Container not found');

    if (data.enable_money === false && current.enable_money === true) {
      // Issue C6 fix: `error` was previously ignored here. If this count
      // query failed (network blip, RLS misconfig, etc.), `count` would be
      // `undefined`, `undefined > 0` is `false`, and the function would
      // silently proceed to disable money tracking even though we couldn't
      // actually verify no ledger entries exist — a financial safety check
      // failing open instead of closed. Now fails loud (500) instead.
      const { count, error: countErr } = await supabaseAdmin
        .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId);
      if (countErr) throw new Error(countErr.message);
      if (count > 0) throw new BusinessRuleError('Cannot disable money tracking — ledger entries exist');
    }

    const allowedFields = [
      'name', 'subtitle', 'description', 'event_date', 'event_type',
      'event_type_category', 'budget_target', 'budget_currency',
      'public_show_names', 'carry_forward_unpaid', 'recurrence_end',
      'enable_tasks', 'enable_money', 'cover_photos',
    ];

    const updates = {};
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
    const data                         = completeContainerSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

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

    const { error: milestoneErr } = await supabaseAdmin
      .from('milestones')
      .insert({
        workspace_id:   workspaceId,
        title:          `${container.name} completed`,
        milestone_date: now.split('T')[0],
        description:    data.outcome_details || null,
        milestone_type: 'custom',
        created_by:     req.member.id,
      });

    if (milestoneErr) {
      logger.error('Failed to auto-create milestone on container completion', { containerId, error: milestoneErr.message });
    }

    const { data: participants } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id').eq('container_id', containerId);

    await notification.send({ type: 'container_completed', workspaceId, recipientIds: (participants || []).map((p) => p.workspace_member_id), referenceType: 'container', referenceId: containerId, variables: { container: container.name } });
    await audit.log({ ...audit.fromReq(req), action: 'container.completed', targetType: 'container', targetId: containerId });

    success(res, { container: updated });
  } catch (err) { next(err); }
}

// ── Convert to Recurring (Issue 5) ────────────────────────────────
//
// Issue 5 fix: replaced two sequential writes (INSERT container, UPSERT
// participants) with a single atomic RPC call. Previously, if the participant
// upsert failed after the container insert succeeded, a new orphan recurring
// container would exist with no participants, leaving an inconsistent state
// that required manual cleanup.
// Now: convert_event_to_recurring_atomic executes both operations inside a
// PostgreSQL transaction, rolling back if either fails.

async function convertToRecurring(req, res, next) {
  try {
    const data                         = convertToRecurringSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const { data: source, error: fetchErr } = await supabaseAdmin
      .from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!source) throw new NotFoundError('Container not found');
    if (source.container_type !== 'event') throw new BusinessRuleError('Only event containers can be converted to recurring');
    if (!['active', 'completed'].includes(source.status)) throw new BusinessRuleError('Container must be active or completed to convert');

    // Issue 5: single atomic RPC replaces two sequential writes
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('convert_event_to_recurring_atomic', {
      p_source_container_id: containerId,
      p_workspace_id:        workspaceId,
      p_new_name:            data.new_name             || source.name,
      p_recurrence_cadence:  data.recurrence_cadence,
      p_recurrence_days:     data.recurrence_days      || null,
      p_recurrence_start:    data.recurrence_start,
      p_recurrence_end:      data.recurrence_end       || null,
      p_carry_forward_unpaid: data.carry_forward_unpaid,
      p_created_by:          req.member.id,
    });

    if (rpcErr) throw new Error(rpcErr.message);

    const newContainer = rpcResult;

    try {
      await getQueue('cycle-generation-queue').add(
        'generate-cycles',
        { container_id: newContainer.id, generate_months_ahead: 3 },
        { attempts: 3 }
      );
    } catch (queueErr) {
      logger.error('Failed to enqueue cycle generation after conversion — will be picked up by daily maintenance job', {
        containerId: newContainer.id,
        error: queueErr.message,
      });
    }

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
      .in('status', ['active', 'completed'])
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

    success(res, { public_url: `${process.env.FRONTEND_URL}/event/${token}`, public_token: token });
  } catch (err) { next(err); }
}

async function deleteContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    // Issue C6 fix: `error` was previously ignored here — the exact same
    // fail-open bug as updateContainer above, but on the guard that
    // prevents deleting a container with confirmed money movements. Now
    // checked explicitly.
    const { count, error: countErr } = await supabaseAdmin
      .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId).eq('status', 'confirmed');

    if (countErr) throw new Error(countErr.message);
    if (count > 0) throw new BusinessRuleError('Cannot delete a container with confirmed ledger entries');

    const { error: deleteErr } = await supabaseAdmin
      .from('containers').update({ deleted_at: new Date().toISOString() }).eq('id', containerId).eq('workspace_id', workspaceId);

    if (deleteErr) throw new Error(deleteErr.message);

    await audit.log({ ...audit.fromReq(req), action: 'container.deleted', targetType: 'container', targetId: containerId });

    success(res, { message: 'Container deleted.' });
  } catch (err) { next(err); }
}

async function restoreContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('containers')
      .update({ deleted_at: null, updated_at: new Date().toISOString() })
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .not('deleted_at', 'is', null)
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('No soft-deleted container found with this ID');

    await audit.log({ ...audit.fromReq(req), action: 'container.restored', targetType: 'container', targetId: containerId });

    success(res, { container: data });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin  = req.member.role === 'admin';
    const callerId = req.member.id;

    const { data: container, error: cErr } = await supabaseAdmin
      .from('containers')
      .select('id, name, status, budget_target, budget_currency, enable_money')
      .eq('id', containerId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (cErr) throw new Error(cErr.message);
    if (!container) throw new NotFoundError('Container not found');

    const { data: participants, error: pErr } = await supabaseAdmin
      .from('container_participants')
      .select(`
        id, role, money_enabled, workspace_member_id, added_by,
        workspace_members!container_participants_workspace_member_id_fkey (
          display_name, is_proxy
        ),
        contributor_targets(
          target_amount, target_currency, due_date, is_current, cycle_id
        )
      `)
      .eq('container_id', containerId);

    if (pErr) throw new Error(pErr.message);

    const { data: ledger, error: lErr } = await supabaseAdmin
      .from('ledger_entries')
      .select('contributor_id, base_amount, status')
      .eq('container_id', containerId);

    if (lErr) throw new Error(lErr.message);

    const shapedParticipants = (participants || []).map((p) => {
      const member        = p.workspace_members;
      const currentTarget = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
      const entries       = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id);
      const confirmed     = entries.filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const pending       = entries.filter((le) => ['pending', 'proof_uploaded'].includes(le.status)).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const target        = parseFloat(currentTarget?.target_amount || 0);
      const outstanding   = Math.max(0, target - confirmed);

      let status = 'no_target';
      if (target > 0) {
        if (confirmed >= target) status = 'paid';
        else if (confirmed > 0)  status = 'partial';
        else if (currentTarget?.due_date && new Date(currentTarget.due_date) < new Date()) status = 'overdue';
        else status = 'pending';
      }

      const full = {
        member_id:           p.workspace_member_id,
        display_name:        member?.display_name,
        is_proxy:            member?.is_proxy,
        role:                p.role,
        status,
        current_target:      currentTarget ? { amount: currentTarget.target_amount, currency: currentTarget.target_currency, due_date: currentTarget.due_date } : null,
        confirmed_paid_base: confirmed,
        pending_paid_base:   pending,
        outstanding_base:    outstanding,
      };

      if (!isAdmin && p.workspace_member_id !== callerId) {
        return { member_id: p.workspace_member_id, display_name: member?.display_name, is_proxy: member?.is_proxy, role: p.role, status };
      }
      return full;
    });

    const totalExpected  = shapedParticipants.reduce((s, p) => s + parseFloat(p.current_target?.amount || 0), 0);
    const totalConfirmed = shapedParticipants.reduce((s, p) => s + (p.confirmed_paid_base || 0), 0);
    const totalPending   = shapedParticipants.reduce((s, p) => s + (p.pending_paid_base   || 0), 0);
    const progressPct    = totalExpected > 0 ? Math.round((totalConfirmed / totalExpected) * 100) : null;

    success(res, {
      container,
      total_expected_base:  totalExpected,
      total_confirmed_base: totalConfirmed,
      total_pending_base:   totalPending,
      progress_pct:         progressPct,
      participants:         shapedParticipants,
    });
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
    const data                         = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await generateUploadUrl({ workspaceId, folder: `outcome/${containerId}`, filename: data.filename, contentType: data.content_type, fileSize: data.file_size, fileType: 'outcome_file' });
    success(res, result);
  } catch (err) { next(err); }
}

async function generateCoverPhotoUploadUrl(req, res, next) {
  try {
    const data                         = uploadFileSchema.parse(req.body);
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
      name:                 container.name,
      subtitle:             container.subtitle,
      event_date:           container.event_date,
      budget_target:        container.budget_target,
      budget_currency:      container.budget_currency,
      total_confirmed_base: total,
      progress_pct:         progressPct,
      workspace_name:       container.workspaces?.name,
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

module.exports = {
  listContainers,
  createContainer,
  getContainer,
  updateContainer,
  completeContainer,
  convertToRecurring,
  archiveContainer,
  generatePublicLink,
  deleteContainer,
  restoreContainer,
  getSummary,
  listCycles,
  generateOutcomeFileUploadUrl,
  generateCoverPhotoUploadUrl,
  getPublicContainer,
};
