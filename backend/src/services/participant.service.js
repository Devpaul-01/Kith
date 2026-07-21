// src/services/participant.service.js
//
// Preserves the batch-validate/batch-upsert pattern and the atomic
// set_contributor_target_atomic RPC usage.

const { supabaseAdmin }      = require('../config/supabase');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const audit = require('./audit.service');
const logger = require('../utils/logger');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');

async function listParticipants({ containerId }) {
  const { data, error } = await supabaseAdmin
    .from('container_participants')
    .select(`
      *,
      workspace_members!container_participants_workspace_member_id_fkey (
        display_name,
        is_proxy,
        role
      ),
      contributor_targets(
        target_amount,
        target_currency,
        due_date,
        id,
        is_current,
        cycle_id
      )
    `)
    .eq('container_id', containerId);

  if (error) throw new Error(error.message);

  return (data || []).map((p) => {
    const currentTarget = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
    return {
      ...p,
      display_name:    p.workspace_members?.display_name,
      is_proxy:        p.workspace_members?.is_proxy,
      member_role:     p.workspace_members?.role,
      target_amount:   currentTarget?.target_amount,
      target_currency: currentTarget?.target_currency,
      due_date:        currentTarget?.due_date,
      target_id:       currentTarget?.id,
      workspace_members: undefined,
      contributor_targets: undefined,
    };
  });
}

async function addParticipants({ workspaceId, containerId, participants, actorMemberId, actorCtx }) {
  const { data: container, error: containerError } = await supabaseAdmin
    .from('containers')
    .select('enable_money, enable_tasks, status')
    .eq('id', containerId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .maybeSingle();

  if (containerError) throw new Error(containerError.message);
  if (!container) throw new NotFoundError('Container not found');

  if (container.status !== 'active') {
    throw new BusinessRuleError('Cannot add participants to a completed or archived container');
  }

  const memberIds = participants.map(p => p.workspace_member_id);
  const { data: validMembers } = await supabaseAdmin
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('id', memberIds)
    .is('deleted_at', null);

  const validMemberIds = new Set((validMembers || []).map(m => m.id));

  const validParticipants = participants.filter((p) => validMemberIds.has(p.workspace_member_id));
  const skippedInvalidMember = participants.length - validParticipants.length;

  let added = [];
  let skippedAlreadyPresent = 0;

  if (validParticipants.length) {
    const upsertRows = validParticipants.map((p) => ({
      container_id:         containerId,
      workspace_member_id:  p.workspace_member_id,
      money_enabled:        container.enable_money ? (p.money_enabled ?? false) : false,
      tasks_enabled:        container.enable_tasks ? (p.tasks_enabled ?? false) : false,
      role:                 p.role  || null,
      notes:                p.notes || null,
      added_by:             actorMemberId,
    }));

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('container_participants')
      .upsert(upsertRows, { onConflict: 'container_id,workspace_member_id', ignoreDuplicates: true })
      .select();

    if (insertError) throw new Error(insertError.message);

    added = inserted || [];
    skippedAlreadyPresent = validParticipants.length - added.length;

    const insertedByMemberId = new Map(added.map((row) => [row.workspace_member_id, row]));

    for (const p of validParticipants) {
      const insertedRow = insertedByMemberId.get(p.workspace_member_id);
      if (!insertedRow || !p.target || !container.enable_money || !(p.target.amount > 0)) continue;

      const { error: targetError } = await supabaseAdmin
        .from('contributor_targets')
        .insert({
          container_participant_id: insertedRow.id,
          container_id:             containerId,
          workspace_member_id:      p.workspace_member_id,
          target_amount:            p.target.amount,
          target_currency:          p.target.currency || container.budget_currency || 'USD',
          due_date:                 p.target.due_date || null,
          set_by:                   actorMemberId,
        });

      if (targetError) {
        logger.error('Failed to create contributor target during addParticipants', {
          containerId, memberId: p.workspace_member_id, error: targetError.message,
        });
      }
    }
  }

  await audit.log({
    ...actorCtx,
    action: AUDIT_ACTIONS.CONTAINER_PARTICIPANTS_ADDED,
    targetType: 'container',
    targetId: containerId,
    metadata: {
      added_count: added.length,
      skipped_already_present: skippedAlreadyPresent,
      skipped_invalid_member: skippedInvalidMember
    }
  });

  return {
    added,
    skipped_already_present: skippedAlreadyPresent,
    skipped_invalid_member: skippedInvalidMember
  };
}

async function addParticipantsFromGroup({ workspaceId, containerId, groupId, moneyEnabled, tasksEnabled, actorMemberId }) {
  const { data: container } = await supabaseAdmin.from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
  if (!container) throw new NotFoundError('Container not found');

  const { data: groupMembers } = await supabaseAdmin
    .from('group_members')
    .select('workspace_member_id, workspace_members!inner(deleted_at)')
    .eq('group_id', groupId)
    .is('workspace_members.deleted_at', null);

  const rows = (groupMembers || []).map((gm) => ({
    container_id:        containerId,
    workspace_member_id: gm.workspace_member_id,
    money_enabled:       container.enable_money ? (moneyEnabled ?? false) : false,
    tasks_enabled:       tasksEnabled ?? false,
    added_by:            actorMemberId,
  }));

  let added = 0, skipped = 0;

  if (rows.length) {
    const { data: inserted, error } = await supabaseAdmin
      .from('container_participants')
      .upsert(rows, { onConflict: 'container_id,workspace_member_id', ignoreDuplicates: true })
      .select('id');

    if (error) throw new Error(error.message);

    added   = (inserted || []).length;
    skipped = rows.length - added;
  }

  return { added, skipped };
}

async function updateParticipant({ containerId, participantId, data }) {
  const allowed  = ['money_enabled','tasks_enabled','role','notes','exclude_from_public'];
  const updates  = {};
  for (const field of allowed) { if (data[field] !== undefined) updates[field] = data[field]; }

  if (!Object.keys(updates).length) {
    const { data: p } = await supabaseAdmin.from('container_participants').select('*').eq('id', participantId).single();
    return p;
  }

  // Mirrors the container-level guard on disabling money tracking with
  // existing ledger entries.
  if (updates.money_enabled === false) {
    const { data: participantRow } = await supabaseAdmin
      .from('container_participants').select('workspace_member_id').eq('id', participantId).eq('container_id', containerId).maybeSingle();

    if (participantRow) {
      const { count, error: countErr } = await supabaseAdmin
        .from('ledger_entries')
        .select('*', { count: 'exact', head: true })
        .eq('container_id', containerId)
        .eq('contributor_id', participantRow.workspace_member_id)
        .eq('status', 'confirmed');

      if (countErr) throw new Error(countErr.message);
      if (count > 0) throw new BusinessRuleError('Cannot disable money tracking for a participant with confirmed ledger entries');
    }
  }

  const { data: participant, error } = await supabaseAdmin
    .from('container_participants').update(updates).eq('id', participantId).eq('container_id', containerId).select().maybeSingle();

  if (error) throw new Error(error.message);
  if (!participant) throw new NotFoundError('Participant not found');

  return participant;
}

async function removeParticipant({ containerId, participantId }) {
  const { data: participant } = await supabaseAdmin.from('container_participants').select('*').eq('id', participantId).eq('container_id', containerId).maybeSingle();
  if (!participant) throw new NotFoundError('Participant not found');

  const { count, error: countErr } = await supabaseAdmin
    .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId).eq('contributor_id', participant.workspace_member_id).eq('status', 'confirmed');
  if (countErr) throw new Error(countErr.message);
  if (count > 0) throw new BusinessRuleError('Cannot remove participant with confirmed ledger entries');

  await supabaseAdmin.from('container_participants').delete().eq('id', participantId);
}

async function setTarget({ containerId, participantId, amount, currency, due_date, actorMemberId }) {
  const { data: participant } = await supabaseAdmin
    .from('container_participants')
    .select('*, containers!inner(enable_money)')
    .eq('id', participantId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (!participant) throw new NotFoundError('Participant not found');
  if (!participant.containers?.enable_money) throw new BusinessRuleError('Container does not have money tracking enabled');

  // Single atomic RPC instead of three sequential, non-transactional
  // writes.
  const { data: rpcResult, error } = await supabaseAdmin.rpc('set_contributor_target_atomic', {
    p_container_participant_id: participantId,
    p_container_id:             containerId,
    p_workspace_member_id:      participant.workspace_member_id,
    p_target_amount:             amount,
    p_target_currency:           currency,
    p_due_date:                  due_date || null,
    p_set_by:                    actorMemberId,
  });

  if (error) throw new Error(error.message);

  return { target: rpcResult.new_target, previous_target: rpcResult.previous_target };
}

async function getTargetHistory({ participantId }) {
  const { data, error } = await supabaseAdmin
    .from('contributor_targets')
    .select('*, set_by_member:workspace_members!set_by(display_name)')
    .eq('container_participant_id', participantId)
    .order('set_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data || []).map((t) => ({ ...t, set_by_name: t.set_by_member?.display_name, set_by_member: undefined }));
}

async function getCycleTargets({ containerId, participantId }) {
  const { data: participant } = await supabaseAdmin
    .from('container_participants')
    .select('*, workspace_members!inner(display_name)')
    .eq('id', participantId)
    .eq('container_id', containerId)
    .maybeSingle();

  if (!participant) throw new NotFoundError('Participant not found');

  const { data: cycles } = await supabaseAdmin.from('container_cycles').select('*').eq('container_id', containerId).order('cycle_number', { ascending: true });

  const { data: cycleTargets } = await supabaseAdmin
    .from('contributor_targets').select('*').eq('container_participant_id', participantId).eq('is_current', true).not('cycle_id', 'is', null);

  const { data: ledger } = await supabaseAdmin
    .from('ledger_entries').select('cycle_id, base_amount, status').eq('contributor_id', participant.workspace_member_id).eq('container_id', containerId).eq('status', 'confirmed');

  const result = (cycles || []).map((c) => {
    const target    = (cycleTargets || []).find((ct) => ct.cycle_id === c.id);
    const confirmed = (ledger || []).filter((le) => le.cycle_id === c.id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
    const tAmount   = parseFloat(target?.target_amount || 0);
    let status = 'pending';
    if (!target) status = 'skipped';
    else if (confirmed >= tAmount) status = 'paid';
    else if (confirmed > 0) status = 'partial';
    else if (c.status === 'closed') status = 'overdue';
    return {
      cycle:             { id: c.id, cycle_number: c.cycle_number, cycle_start: c.cycle_start, cycle_end: c.cycle_end, status: c.status },
      target:            target ? { id: target.id, amount: target.target_amount, currency: target.target_currency } : null,
      confirmed_paid_base: confirmed,
      status,
    };
  });

  return { participant: { ...participant, display_name: participant.workspace_members?.display_name, workspace_members: undefined }, cycle_targets: result };
}

async function overrideCycle({ workspaceId, containerId, cycleId, data, actorMemberId, actorCtx }) {
  const { data: cycle } = await supabaseAdmin.from('container_cycles').select('*').eq('id', cycleId).eq('container_id', containerId).maybeSingle();
  if (!cycle) throw new NotFoundError('Cycle not found');
  if (!['upcoming','open'].includes(cycle.status)) throw new BusinessRuleError('Can only override upcoming or open cycles');

  if (data.override_type === 'skip_member'   && !data.member_id)  throw new BusinessRuleError('member_id required for skip_member override');
  if (data.override_type === 'adjust_target' && !data.new_target) throw new BusinessRuleError('new_target required for adjust_target override');

  const { data: override, error } = await supabaseAdmin
    .from('pool_cycle_overrides')
    .insert({ container_id: containerId, cycle_start: cycle.cycle_start, override_type: data.override_type, member_id: data.member_id || null, new_target: data.new_target || null, new_currency: data.new_currency || null, reason: data.reason || null, created_by: actorMemberId })
    .select()
    .single();

  if (error) throw new Error(error.message);

  if (data.override_type === 'pause_pool') {
    await supabaseAdmin.from('container_cycles').update({ status: 'skipped' }).eq('id', cycleId);
  }

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.CYCLE_OVERRIDE_APPLIED, targetType: 'container_cycle', targetId: cycleId, metadata: { override_type: data.override_type } });

  return override;
}

module.exports = { listParticipants, addParticipants, addParticipantsFromGroup, updateParticipant, removeParticipant, setTarget, getTargetHistory, getCycleTargets, overrideCycle };
