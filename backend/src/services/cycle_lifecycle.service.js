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

async function carryForwardUnpaid(cycle) {
  const { data: participants } = await supabaseAdmin
    .from('container_participants')
    .select('workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id, is_current)')
    .eq('container_id', cycle.container_id)
    .eq('money_enabled', true);

  const { data: ledger } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, base_amount, status, cycle_id')
    .eq('cycle_id', cycle.id)
    .eq('status', 'confirmed');

  const { data: nextCycle } = await supabaseAdmin
    .from('container_cycles')
    .select('id')
    .eq('container_id', cycle.container_id)
    .in('status', ['open', 'upcoming'])
    .neq('id', cycle.id)
    .order('cycle_number', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextCycle?.id) return;

  const note = `Carried forward from cycle (closed ${cycle.cycle_end})`;

  // Skip contributors already carried forward (a retry after a partial failure).
  const { data: existing } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id')
    .eq('cycle_id', nextCycle.id)
    .eq('entry_type', 'carry_forward')
    .eq('note', note);
  const already = new Set((existing || []).map((e) => e.contributor_id));

  for (const p of (participants || [])) {
    if (already.has(p.workspace_member_id)) continue;

    const cycleTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id && t.is_current);
    if (!cycleTarget) continue;

    const paid        = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
    const outstanding = parseFloat(cycleTarget.target_amount) - paid;
    if (outstanding <= 0) continue;

    const { error } = await supabaseAdmin.from('ledger_entries').insert({
      workspace_id:      cycle.containers.workspace_id,
      container_id:      cycle.container_id,
      cycle_id:          nextCycle.id,
      entry_type:        'carry_forward',
      contributor_id:    p.workspace_member_id,
      original_amount:   outstanding,
      original_currency: cycleTarget.target_currency,
      base_amount:       outstanding,
      status:            'confirmed',
      // NULL = recorded by the system, not a member (requires 002_hardening.sql)
      recorded_by:       null,
      confirmed_at:      new Date().toISOString(),
      confirmed_by:      null,
      note,
    });
    if (error) throw new Error(error.message);
  }
}

async function closeDueCycles(today) {
  const { data: toClose } = await supabaseAdmin
    .from('container_cycles')
    .select('*, containers!inner(workspace_id, carry_forward_unpaid)')
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
