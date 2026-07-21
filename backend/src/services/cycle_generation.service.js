// src/services/cycle_generation.service.js
//
// Preserves the batch-fetch optimization (all pool_cycle_overrides +
// participants fetched once upfront into lookup Maps, eliminating
// O(participants × cycles) DB round trips inside the loop).

const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');

async function generateCycles({ container_id, generate_months_ahead = 3 }) {
  logger.info('Generating cycles', { container_id, generate_months_ahead });

  const { data: container } = await supabaseAdmin
    .from('containers')
    .select('*')
    .eq('id', container_id)
    .eq('container_type', 'recurring')
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();

  if (!container) return;

  const { data: lastCycle } = await supabaseAdmin
    .from('container_cycles')
    .select('*')
    .eq('container_id', container_id)
    .order('cycle_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  let nextCycleNumber = 1;
  let nextStart       = new Date(container.recurrence_start);

  if (lastCycle) {
    nextCycleNumber = lastCycle.cycle_number + 1;
    const lastEnd   = new Date(lastCycle.cycle_end);
    nextStart       = new Date(lastEnd);
    nextStart.setDate(nextStart.getDate() + 1);
  }

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() + generate_months_ahead);
  if (container.recurrence_end && new Date(container.recurrence_end) < cutoffDate) {
    cutoffDate.setTime(new Date(container.recurrence_end).getTime());
  }

  const today = new Date();

  const { data: allOverrides } = await supabaseAdmin
    .from('pool_cycle_overrides')
    .select('override_type, cycle_start, member_id, new_target, new_currency')
    .eq('container_id', container_id);

  const pauseOverrides  = new Set(
    (allOverrides || []).filter((o) => o.override_type === 'pause_pool').map((o) => o.cycle_start)
  );
  const skipOverrides   = new Set(
    (allOverrides || []).filter((o) => o.override_type === 'skip_member').map((o) => `${o.cycle_start}:${o.member_id}`)
  );
  const adjustOverrides = new Map(
    (allOverrides || [])
      .filter((o) => o.override_type === 'adjust_target')
      .map((o) => [`${o.cycle_start}:${o.member_id}`, { new_target: o.new_target, new_currency: o.new_currency }])
  );

  const { data: participants } = await supabaseAdmin
    .from('container_participants')
    .select('id, workspace_member_id, contributor_targets(target_amount, target_currency, is_current, cycle_id)')
    .eq('container_id', container_id)
    .eq('money_enabled', true);

  while (nextStart <= cutoffDate) {
    let cycleEnd = new Date(nextStart);

    switch (container.recurrence_cadence) {
      case 'weekly':    cycleEnd.setDate(cycleEnd.getDate() + 6); break;
      case 'monthly':   cycleEnd.setMonth(cycleEnd.getMonth() + 1);           cycleEnd.setDate(cycleEnd.getDate() - 1); break;
      case 'quarterly': cycleEnd.setMonth(cycleEnd.getMonth() + 3);           cycleEnd.setDate(cycleEnd.getDate() - 1); break;
      case 'yearly':    cycleEnd.setFullYear(cycleEnd.getFullYear() + 1);     cycleEnd.setDate(cycleEnd.getDate() - 1); break;
      case 'custom':    cycleEnd.setDate(cycleEnd.getDate() + (container.recurrence_days || 30) - 1); break;
      default:          cycleEnd.setMonth(cycleEnd.getMonth() + 1);           cycleEnd.setDate(cycleEnd.getDate() - 1);
    }

    const cycleStartStr = nextStart.toISOString().split('T')[0];
    const cycleEndStr   = cycleEnd.toISOString().split('T')[0];

    const status = pauseOverrides.has(cycleStartStr)
      ? 'skipped'
      : (nextStart <= today ? 'open' : 'upcoming');

    const { data: cycleRow } = await supabaseAdmin
      .from('container_cycles')
      .upsert(
        { container_id, cycle_number: nextCycleNumber, cycle_start: cycleStartStr, cycle_end: cycleEndStr, status },
        { onConflict: 'container_id,cycle_start', ignoreDuplicates: true }
      )
      .select('id')
      .maybeSingle();

    if (cycleRow && status !== 'skipped') {
      const cycleId = cycleRow.id;

      for (const p of (participants || [])) {
        if (skipOverrides.has(`${cycleStartStr}:${p.workspace_member_id}`)) continue;

        const adjustOverride = adjustOverrides.get(`${cycleStartStr}:${p.workspace_member_id}`);
        const baseTarget     = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
        const targetAmount   = adjustOverride?.new_target   || baseTarget?.target_amount;
        const targetCurrency = adjustOverride?.new_currency || baseTarget?.target_currency;

        if (targetAmount) {
          await supabaseAdmin.from('contributor_targets').upsert(
            {
              container_participant_id: p.id,
              container_id,
              workspace_member_id: p.workspace_member_id,
              cycle_id:        cycleId,
              target_amount:   targetAmount,
              target_currency: targetCurrency,
              due_date:        cycleEndStr,
              set_by:          container.created_by,
              is_current:      true,
            },
            { ignoreDuplicates: true }
          );
        }
      }
    }

    nextCycleNumber++;
    nextStart = new Date(cycleEnd);
    nextStart.setDate(nextStart.getDate() + 1);
  }

  logger.info('Cycle generation complete', { container_id });
}

module.exports = { generateCycles };
