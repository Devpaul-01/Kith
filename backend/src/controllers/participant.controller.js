// src/controllers/participant.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');
const { addParticipantsSchema, addParticipantsFromGroupSchema, updateParticipantSchema, setTargetSchema, cycleOverrideSchema } = require('../validators/ledger.validator');
const audit = require('../services/audit.service');

async function listParticipants(req, res, next) {
  try {
    const { containerId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('container_participants')
      .select(`
        *, workspace_members!inner(display_name, is_proxy, role),
        contributor_targets(target_amount, target_currency, due_date, id, is_current, cycle_id)
      `)
      .eq('container_id', containerId);

    if (error) throw new Error(error.message);

    const participants = (data || []).map((p) => {
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
        workspace_members: undefined, contributor_targets: undefined,
      };
    });

    success(res, { participants });
  } catch (err) { next(err); }
}

async function addParticipants(req, res, next) {
  try {
    const data                          = addParticipantsSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: container } = await supabaseAdmin.from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
    if (!container) throw new NotFoundError('Container not found');

    const added = [];
    let skippedAlreadyPresent = 0;

    for (const p of data.participants) {
      const { data: memberCheck } = await supabaseAdmin.from('workspace_members').select('id').eq('id', p.workspace_member_id).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
      if (!memberCheck) continue;

      const moneyEnabled = container.enable_money ? (p.money_enabled ?? false) : false;

      const { data: inserted } = await supabaseAdmin
        .from('container_participants')
        .upsert({ container_id: containerId, workspace_member_id: p.workspace_member_id, money_enabled: moneyEnabled, tasks_enabled: p.tasks_enabled ?? false, role: p.role || null, notes: p.notes || null, added_by: req.member.id }, { onConflict: 'container_id,workspace_member_id', ignoreDuplicates: true })
        .select()
        .maybeSingle();

      if (!inserted) { skippedAlreadyPresent++; continue; }

      if (p.target && container.enable_money) {
        await supabaseAdmin.from('contributor_targets').insert({ container_participant_id: inserted.id, container_id: containerId, workspace_member_id: p.workspace_member_id, target_amount: p.target.amount, target_currency: p.target.currency, due_date: p.target.due_date || null, set_by: req.member.id });
      }

      added.push(inserted);
    }

    success(res, { added, skipped_already_present: skippedAlreadyPresent }, 201);
  } catch (err) { next(err); }
}

async function addParticipantsFromGroup(req, res, next) {
  try {
    const data                          = addParticipantsFromGroupSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const { data: container } = await supabaseAdmin.from('containers').select('*').eq('id', containerId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
    if (!container) throw new NotFoundError('Container not found');

    const { data: groupMembers } = await supabaseAdmin
      .from('group_members')
      .select('workspace_member_id, workspace_members!inner(deleted_at)')
      .eq('group_id', data.group_id)
      .is('workspace_members.deleted_at', null);

    let added = 0, skipped = 0;

    for (const gm of (groupMembers || [])) {
      const moneyEnabled = container.enable_money ? (data.money_enabled ?? false) : false;
      const { data: inserted } = await supabaseAdmin
        .from('container_participants')
        .upsert({ container_id: containerId, workspace_member_id: gm.workspace_member_id, money_enabled: moneyEnabled, tasks_enabled: data.tasks_enabled ?? false, added_by: req.member.id }, { onConflict: 'container_id,workspace_member_id', ignoreDuplicates: true })
        .select('id')
        .maybeSingle();

      if (inserted) added++; else skipped++;
    }

    success(res, { added, skipped });
  } catch (err) { next(err); }
}

async function updateParticipant(req, res, next) {
  try {
    const data                          = updateParticipantSchema.parse(req.body);
    const { containerId, participantId } = req.params;

    const allowed  = ['money_enabled','tasks_enabled','role','notes','exclude_from_public'];
    const updates  = {};
    for (const field of allowed) { if (data[field] !== undefined) updates[field] = data[field]; }

    if (!Object.keys(updates).length) {
      const { data: p } = await supabaseAdmin.from('container_participants').select('*').eq('id', participantId).single();
      return success(res, { participant: p });
    }

    const { data: participant, error } = await supabaseAdmin
      .from('container_participants').update(updates).eq('id', participantId).eq('container_id', containerId).select().maybeSingle();

    if (error) throw new Error(error.message);
    if (!participant) throw new NotFoundError('Participant not found');

    success(res, { participant });
  } catch (err) { next(err); }
}

async function removeParticipant(req, res, next) {
  try {
    const { containerId, participantId } = req.params;

    const { data: participant } = await supabaseAdmin.from('container_participants').select('*').eq('id', participantId).eq('container_id', containerId).maybeSingle();
    if (!participant) throw new NotFoundError('Participant not found');

    const { count } = await supabaseAdmin.from('ledger_entries').select('*', { count: 'exact', head: true }).eq('container_id', containerId).eq('contributor_id', participant.workspace_member_id).eq('status', 'confirmed');
    if (count > 0) throw new BusinessRuleError('Cannot remove participant with confirmed ledger entries');

    await supabaseAdmin.from('container_participants').delete().eq('id', participantId);
    success(res, { message: 'Participant removed.' });
  } catch (err) { next(err); }
}

async function setTarget(req, res, next) {
  try {
    const data                          = setTargetSchema.parse(req.body);
    const { containerId, participantId } = req.params;

    const { data: participant } = await supabaseAdmin
      .from('container_participants')
      .select('*, containers!inner(enable_money)')
      .eq('id', participantId)
      .eq('container_id', containerId)
      .maybeSingle();

    if (!participant) throw new NotFoundError('Participant not found');
    if (!participant.containers?.enable_money) throw new BusinessRuleError('Container does not have money tracking enabled');

    // Supersede existing current target
    const { data: existing } = await supabaseAdmin
      .from('contributor_targets').select('id, *').eq('container_participant_id', participantId).eq('is_current', true).is('cycle_id', null).maybeSingle();

    if (existing) {
      await supabaseAdmin.from('contributor_targets').update({ is_current: false, superseded_at: new Date().toISOString() }).eq('id', existing.id);
    }

    const { data: newTarget, error } = await supabaseAdmin
      .from('contributor_targets')
      .insert({
        container_participant_id: participantId, container_id: containerId,
        workspace_member_id: participant.workspace_member_id,
        target_amount: data.amount, target_currency: data.currency,
        due_date: data.due_date || null, is_current: true, set_by: req.member.id,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Link superseded_by
    if (existing) {
      await supabaseAdmin.from('contributor_targets').update({ superseded_by: newTarget.id }).eq('id', existing.id);
    }

    success(res, { target: newTarget, previous_target: existing || null });
  } catch (err) { next(err); }
}

async function getTargetHistory(req, res, next) {
  try {
    const { participantId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('contributor_targets')
      .select('*, set_by_member:workspace_members!set_by(display_name)')
      .eq('container_participant_id', participantId)
      .order('set_at', { ascending: false });

    if (error) throw new Error(error.message);

    const history = (data || []).map((t) => ({ ...t, set_by_name: t.set_by_member?.display_name, set_by_member: undefined }));
    success(res, { history });
  } catch (err) { next(err); }
}

async function getCycleTargets(req, res, next) {
  try {
    const { containerId, participantId } = req.params;

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

    success(res, { participant: { ...participant, display_name: participant.workspace_members?.display_name, workspace_members: undefined }, cycle_targets: result });
  } catch (err) { next(err); }
}

async function overrideCycle(req, res, next) {
  try {
    const data                                    = cycleOverrideSchema.parse(req.body);
    const { workspaceId, containerId, cycleId }   = req.params;

    const { data: cycle } = await supabaseAdmin.from('container_cycles').select('*').eq('id', cycleId).eq('container_id', containerId).maybeSingle();
    if (!cycle) throw new NotFoundError('Cycle not found');
    if (!['upcoming','open'].includes(cycle.status)) throw new BusinessRuleError('Can only override upcoming or open cycles');

    if (data.override_type === 'skip_member'   && !data.member_id)  throw new BusinessRuleError('member_id required for skip_member override');
    if (data.override_type === 'adjust_target' && !data.new_target) throw new BusinessRuleError('new_target required for adjust_target override');

    const { data: override, error } = await supabaseAdmin
      .from('pool_cycle_overrides')
      .insert({ container_id: containerId, cycle_start: cycle.cycle_start, override_type: data.override_type, member_id: data.member_id || null, new_target: data.new_target || null, new_currency: data.new_currency || null, reason: data.reason || null, created_by: req.member.id })
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (data.override_type === 'pause_pool') {
      await supabaseAdmin.from('container_cycles').update({ status: 'skipped' }).eq('id', cycleId);
    }

    await audit.log({ ...audit.fromReq(req), action: 'cycle.override_applied', targetType: 'container_cycle', targetId: cycleId, metadata: { override_type: data.override_type } });

    success(res, { override });
  } catch (err) { next(err); }
}

module.exports = { listParticipants, addParticipants, addParticipantsFromGroup, updateParticipant, removeParticipant, setTarget, getTargetHistory, getCycleTargets, overrideCycle };
