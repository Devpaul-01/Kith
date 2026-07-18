// src/services/reminder.service.js
//
// Extracted from workers/background.workers.js#createReminderWorker as
// part of the service-layer refactor. All DB reads/writes and
// notification orchestration for the daily reminder scan now live here;
// the worker only pulls the job and calls runReminderScan().

const { supabaseAdmin } = require('../config/supabase');
const notification      = require('./notification.service');
const logger            = require('../utils/logger');

async function sendUpcomingPaymentReminders(scanDate, soonStr) {
  const { data: upcomingTargets } = await supabaseAdmin
    .from('contributor_targets')
    .select(`
      id, target_amount, target_currency, due_date,
      workspace_member_id,
      container:containers!container_id(id, name, workspace_id, status),
      cycle_id
    `)
    .eq('is_current', true)
    .gte('due_date', scanDate)
    .lte('due_date', soonStr)
    .is('cycle_id', null);

  for (const target of (upcomingTargets || [])) {
    if (!target.container || target.container.status !== 'active') continue;

    try {
      await notification.send({
        type:          'payment_reminder',
        workspaceId:   target.container.workspace_id,
        recipientIds:  [target.workspace_member_id],
        referenceType: 'container',
        referenceId:   target.container.id,
        variables: {
          amount:    `${target.target_amount} ${target.target_currency}`,
          container: target.container.name,
          due_date:  target.due_date,
        },
        dedupKey: `payment_reminder:${target.id}:${scanDate}`,
      });
    } catch (err) {
      // Isolate per-item failures so one bad target doesn't fail the
      // entire scan (and force BullMQ to retry — and re-send — every
      // reminder in the batch).
      logger.error('Reminder scan: failed to send payment_reminder', { targetId: target.id, error: err.message });
    }
  }
}

async function sendOverdueReminders(scanDate) {
  const { data: overdueTargets } = await supabaseAdmin
    .from('contributor_targets')
    .select(`
      id, target_amount, target_currency, due_date,
      workspace_member_id,
      container:containers!container_id(id, name, workspace_id, status)
    `)
    .eq('is_current', true)
    .lt('due_date', scanDate)
    .is('cycle_id', null);

  for (const target of (overdueTargets || [])) {
    if (!target.container || target.container.status !== 'active') continue;

    try {
      await notification.send({
        type:          'overdue_reminder',
        workspaceId:   target.container.workspace_id,
        recipientIds:  [target.workspace_member_id],
        referenceType: 'container',
        referenceId:   target.container.id,
        variables:     { container: target.container.name },
        dedupKey:      `overdue_reminder:${target.id}:${scanDate}`,
      });
    } catch (err) {
      logger.error('Reminder scan: failed to send overdue_reminder', { targetId: target.id, error: err.message });
    }
  }

  return overdueTargets || [];
}

// Notification finding (audit 5.5): 'overdue_summary_admin' was a fully
// defined template that nothing ever sent. Reuses the overdueTargets
// already fetched by sendOverdueReminders (no extra query), grouped by
// container, one summary per container per day to that container's
// workspace admins.
async function sendAdminOverdueSummaries(overdueTargets, scanDate) {
  const overdueByContainer = new Map();
  for (const target of overdueTargets) {
    if (!target.container || target.container.status !== 'active') continue;
    const key = target.container.id;
    if (!overdueByContainer.has(key)) {
      overdueByContainer.set(key, { container: target.container, count: 0 });
    }
    overdueByContainer.get(key).count += 1;
  }

  for (const { container, count } of overdueByContainer.values()) {
    try {
      const { data: admins } = await supabaseAdmin
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', container.workspace_id)
        .eq('role', 'admin')
        .eq('is_active', true)
        .is('deleted_at', null);

      await notification.send({
        type:          'overdue_summary_admin',
        workspaceId:   container.workspace_id,
        recipientIds:  (admins || []).map((a) => a.id),
        referenceType: 'container',
        referenceId:   container.id,
        variables:     { count, container: container.name },
        dedupKey:      `overdue_summary_admin:${container.id}:${scanDate}`,
      });
    } catch (err) {
      logger.error('Reminder scan: failed to send overdue_summary_admin', { containerId: container.id, error: err.message });
    }
  }
}

// Notification finding (audit 5.5): 'cycle_closing_soon' was a fully
// defined template that nothing ever sent. Notifies participants of open
// recurring-pool cycles ending within the next 3 days who still have an
// outstanding balance for that cycle.
async function sendCycleClosingSoonReminders(scanDate, closingSoonStr) {
  const { data: closingSoonCycles } = await supabaseAdmin
    .from('container_cycles')
    .select('id, cycle_end, container_id, containers!inner(id, name, workspace_id, status)')
    .eq('status', 'open')
    .gte('cycle_end', scanDate)
    .lte('cycle_end', closingSoonStr);

  for (const cycle of (closingSoonCycles || [])) {
    if (!cycle.containers || cycle.containers.status !== 'active') continue;

    try {
      const [{ data: participants }, { data: cycleLedger }] = await Promise.all([
        supabaseAdmin
          .from('container_participants')
          .select('workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id, is_current)')
          .eq('container_id', cycle.container_id)
          .eq('money_enabled', true),
        supabaseAdmin
          .from('ledger_entries')
          .select('contributor_id, base_amount')
          .eq('cycle_id', cycle.id)
          .eq('status', 'confirmed'),
      ]);

      for (const p of (participants || [])) {
        const cycleTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id && t.is_current);
        if (!cycleTarget) continue;

        const paid = (cycleLedger || [])
          .filter((le) => le.contributor_id === p.workspace_member_id)
          .reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
        const outstanding = parseFloat(cycleTarget.target_amount) - paid;
        if (outstanding <= 0) continue;

        await notification.send({
          type:          'cycle_closing_soon',
          workspaceId:   cycle.containers.workspace_id,
          recipientIds:  [p.workspace_member_id],
          referenceType: 'container',
          referenceId:   cycle.container_id,
          variables: {
            container:   cycle.containers.name,
            due_date:    cycle.cycle_end,
            outstanding: `${outstanding.toFixed(2)} ${cycleTarget.target_currency}`,
          },
          dedupKey: `cycle_closing_soon:${cycle.id}:${p.workspace_member_id}:${scanDate}`,
        });
      }
    } catch (err) {
      logger.error('Reminder scan: failed to send cycle_closing_soon', { cycleId: cycle.id, error: err.message });
    }
  }
}

async function runReminderScan() {
  const scanDate = new Date().toISOString().split('T')[0];
  logger.info('Running reminder scan', { scanDate });

  const soon = new Date();
  soon.setDate(soon.getDate() + 7);
  const soonStr = soon.toISOString().split('T')[0];

  await sendUpcomingPaymentReminders(scanDate, soonStr);

  const overdueTargets = await sendOverdueReminders(scanDate);
  await sendAdminOverdueSummaries(overdueTargets, scanDate);

  const closingSoonDate = new Date();
  closingSoonDate.setDate(closingSoonDate.getDate() + 3);
  const closingSoonStr = closingSoonDate.toISOString().split('T')[0];
  await sendCycleClosingSoonReminders(scanDate, closingSoonStr);

  logger.info('Reminder scan complete', { scanDate });
}

module.exports = { runReminderScan };
