// src/services/cycle_lifecycle.service.js
//
// Preserves the per-participant target fix (each participant is sent
// their own cycle_started target amount, not participant #1's).

const { supabaseAdmin } = require('../config/supabase');
const { getQueue }      = require('../queues');
const notification      = require('./notification.service');
const logger             = require('../utils/logger');

async function openDueCycles(today) {
  const { data: toOpen } = await supabaseAdmin
    .from('container_cycles')
    .update({ status: 'open' })
    .eq('status', 'upcoming')
    .lte('cycle_start', today)
    .select('id, container_id');

  for (const cycle of (toOpen || [])) {
    const { data: container } = await supabaseAdmin
      .from('containers')
      .select('workspace_id, name')
      .eq('id', cycle.container_id)
      .maybeSingle();

    if (!container) continue;

    const { data: participants } = await supabaseAdmin
      .from('container_participants')
      .select('workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id)')
      .eq('container_id', cycle.container_id)
      .eq('money_enabled', true);

    // Send each participant their own target amount (not a shared
    // first-member amount).
    for (const p of (participants || [])) {
      const recipientTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id);

      try {
        await notification.send({
          type:          'cycle_started',
          workspaceId:   container.workspace_id,
          recipientIds:  [p.workspace_member_id],
          referenceType: 'container',
          referenceId:   cycle.container_id,
          dedupKey:      `cycle_started:${cycle.id}`,
          variables: {
            container: container.name,
            amount:    recipientTarget ? `${recipientTarget.target_amount} ${recipientTarget.target_currency}` : 'TBD',
          },
        });
      } catch (err) {
        logger.error('Cycle lifecycle: failed to send cycle_started notification', { cycleId: cycle.id, memberId: p.workspace_member_id, error: err.message });
      }
    }
  }

  return (toOpen || []).length;
}

// Carry-forward is a DEBT, not a payment: it raises the participant's
// target for the next cycle by whatever they still owed on the closed
// one. It does NOT insert a ledger_entries row. Every summary/report in
// this app treats a confirmed ledger entry as money actually received
// (getLedgerSummary, dashboard/container/participant/invite previews),
// so a 'confirmed' carry_forward entry for the outstanding amount used
// to make an unpaid participant look like they'd already paid it in the
// new cycle. Raising contributor_targets.target_amount instead means
// their existing paid-vs-target comparison (participant.service.js
// #getCycleTargets) now naturally shows "partial"/"overdue" until they
// actually pay the larger amount — no other reporting code needed to
// change.
//
// apply_cycle_carry_forward_atomic (002_ledger_integrity_and_carry_forward_debt.sql)
// does the supersede-and-insert atomically and is idempotent per
// (participant, closed cycle) via a unique constraint, so a lifecycle
// re-run can't double-apply the same debt.
async function carryForwardUnpaid(cycle) {
  const { data: participants } = await supabaseAdmin
    .from('container_participants')
    .select('id, workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id, is_current)')
    .eq('container_id', cycle.container_id)
    .eq('money_enabled', true);

  const { data: ledger } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, base_amount, status, cycle_id')
    .eq('cycle_id', cycle.id)
    .eq('status', 'confirmed');

  const { data: nextCycle } = await supabaseAdmin
    .from('container_cycles')
    .select('id, cycle_end')
    .eq('container_id', cycle.container_id)
    .in('status', ['open', 'upcoming'])
    .neq('id', cycle.id)
    .order('cycle_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextCycle?.id) return;

  for (const p of (participants || [])) {
    const cycleTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id && t.is_current);
    if (!cycleTarget) continue;

    const paid        = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
    const outstanding = parseFloat(cycleTarget.target_amount) - paid;
    if (outstanding <= 0) continue;

    try {
      const { data: result, error } = await supabaseAdmin.rpc('apply_cycle_carry_forward_atomic', {
        p_container_participant_id: p.id,
        p_container_id:             cycle.container_id,
        p_workspace_member_id:      p.workspace_member_id,
        p_from_cycle_id:            cycle.id,
        p_to_cycle_id:              nextCycle.id,
        p_amount:                   outstanding,
        p_currency:                 cycleTarget.target_currency,
        p_due_date:                 nextCycle.cycle_end,
        // System-applied, like cycle_generation.service.js's per-cycle
        // target rows — attributed to whoever created the container
        // rather than a nullable "system" actor.
        p_set_by:                   cycle.containers.created_by,
      });
      if (error) throw new Error(error.message);

      if (!result?.applied) continue; // already carried forward by a previous run

      await notification.send({
        type:          'carry_forward_applied',
        workspaceId:   cycle.containers.workspace_id,
        recipientIds:  [p.workspace_member_id],
        referenceType: 'container',
        referenceId:   cycle.container_id,
        dedupKey:      `carry_forward_applied:${cycle.id}:${p.workspace_member_id}`,
        variables: {
          amount:    `${outstanding.toFixed(2)} ${cycleTarget.target_currency}`,
          container: cycle.container_id,
        },
      });
    } catch (err) {
      logger.error('Cycle lifecycle: failed to carry forward unpaid balance', { cycleId: cycle.id, nextCycleId: nextCycle.id, memberId: p.workspace_member_id, error: err.message });
    }
  }
}

async function closeDueCycles(today) {
  const { data: toClose } = await supabaseAdmin
    .from('container_cycles')
    .select('*, containers!inner(workspace_id, carry_forward_unpaid, created_by)')
    .eq('status', 'open')
    .lt('cycle_end', today);

  let closed = 0;

  for (const cycle of (toClose || [])) {
    // Claim the cycle FIRST with a conditional update, so two overlapping runs can't
    // both process it and double-insert carry-forward entries.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('container_cycles')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', cycle.id)
      .eq('status', 'open')
      .select('id')
      .maybeSingle();

    if (claimErr) {
      logger.error('Cycle lifecycle: failed to claim cycle for closing', { cycleId: cycle.id, error: claimErr.message });
      continue;
    }
    if (!claimed) continue; // another run already closed it

    try {
      if (cycle.containers?.carry_forward_unpaid) await carryForwardUnpaid(cycle);

      await getQueue('cycle-generation-queue').add(
        'generate-cycles',
        { container_id: cycle.container_id, generate_months_ahead: 3 }
      );
      closed++;
    } catch (err) {
      // Compensate: reopen so the next run retries (carryForwardUnpaid is safe to repeat).
      await supabaseAdmin.from('container_cycles').update({ status: 'open', closed_at: null }).eq('id', cycle.id);
      logger.error('Cycle lifecycle: closing failed, cycle reopened for retry', { cycleId: cycle.id, error: err.message });
    }
  }

  return closed;
}

async function runCycleLifecycle() {
  const today = new Date().toISOString().split('T')[0];
  logger.info('Running cycle lifecycle', { today });

  const opened = await openDueCycles(today);
  const closed = await closeDueCycles(today);

  logger.info('Cycle lifecycle complete', { opened, closed });
}

module.exports = { runCycleLifecycle };
