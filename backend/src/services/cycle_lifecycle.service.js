// src/services/cycle_lifecycle.service.js
//
// Extracted from workers/background.workers.js#createCycleLifecycleWorker
// as part of the service-layer refactor. Preserves the per-participant
// target fix (each participant is sent their own cycle_started target
// amount, not participant #1's) exactly as in the original.

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

async function closeDueCycles(today) {
  const { data: toClose } = await supabaseAdmin
    .from('container_cycles')
    .select('*, containers!inner(workspace_id, carry_forward_unpaid)')
    .eq('status', 'open')
    .lt('cycle_end', today);

  for (const cycle of (toClose || [])) {
    if (cycle.containers?.carry_forward_unpaid) {
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
        .in('status', ['open','upcoming'])
        .neq('id', cycle.id)
        .order('cycle_number', { ascending: true })
        .limit(1)
        .maybeSingle();

      for (const p of (participants || [])) {
        const cycleTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id && t.is_current);
        if (!cycleTarget) continue;

        const paid        = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
        const outstanding = parseFloat(cycleTarget.target_amount) - paid;

        if (outstanding > 0 && nextCycle?.id) {
          await supabaseAdmin.from('ledger_entries').insert({
            workspace_id:      cycle.containers.workspace_id,
            container_id:      cycle.container_id,
            cycle_id:          nextCycle.id,
            entry_type:        'carry_forward',
            contributor_id:    p.workspace_member_id,
            original_amount:   outstanding,
            original_currency: cycleTarget.target_currency,
            base_amount:       outstanding,
            status:            'confirmed',
            // NULL indicates this was recorded by the system, not a member
            recorded_by:    null,
            confirmed_at:   new Date().toISOString(),
            confirmed_by:   null,
            note:           `Carried forward from cycle (closed ${cycle.cycle_end})`,
          });
        }
      }
    }

    await supabaseAdmin
      .from('container_cycles')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', cycle.id);

    await getQueue('cycle-generation-queue').add(
      'generate-cycles',
      { container_id: cycle.container_id, generate_months_ahead: 3 }
    );
  }

  return (toClose || []).length;
}

async function runCycleLifecycle() {
  const today = new Date().toISOString().split('T')[0];
  logger.info('Running cycle lifecycle', { today });

  const opened = await openDueCycles(today);
  const closed = await closeDueCycles(today);

  logger.info('Cycle lifecycle complete', { opened, closed });
}

module.exports = { runCycleLifecycle };
