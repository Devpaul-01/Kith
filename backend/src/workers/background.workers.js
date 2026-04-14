// src/workers/background.workers.js
const { Worker }        = require('bullmq');
const { getRedis }      = require('../config/redis');
const { supabaseAdmin } = require('../config/supabase');
const notification      = require('../services/notification.service');
const logger            = require('../utils/logger');

// ── Reminder Worker ────────────────────────────────────────────────

function createReminderWorker() {
  return new Worker(
    'reminder-queue',
    async (job) => {
      const scanDate = job.data.scan_date || new Date().toISOString().split('T')[0];
      logger.info('Running reminder scan', { scanDate });

      // Active containers with money enabled
      const { data: containers } = await supabaseAdmin
        .from('containers')
        .select('id, workspace_id, name, workspace_settings!inner(setting_value)')
        .eq('status', 'active')
        .eq('enable_money', true)
        .is('deleted_at', null);

      for (const container of (containers || [])) {
        const prefs       = container.workspace_settings?.setting_value || {};
        const reminderDays  = prefs.reminder_days_before       || [3, 1];
        const overdueDays   = prefs.overdue_notify_after_days  || [3, 7];

        // Participants with outstanding targets and due dates
        const { data: participants } = await supabaseAdmin
          .from('container_participants')
          .select(`
            workspace_member_id,
            workspace_members!inner(display_name),
            contributor_targets!inner(target_amount, target_currency, due_date, id, is_current, cycle_id),
            ledger_entries:ledger_entries(base_amount, status, container_id)
          `)
          .eq('container_id', container.id)
          .eq('money_enabled', true)
          .eq('contributor_targets.is_current', true)
          .is('contributor_targets.cycle_id', null)
          .not('contributor_targets.due_date', 'is', null);

        for (const p of (participants || [])) {
          const target    = p.contributor_targets?.[0];
          if (!target) continue;

          const confirmedPaid = (p.ledger_entries || [])
            .filter((le) => le.status === 'confirmed' && le.container_id === container.id)
            .reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);

          if (confirmedPaid >= parseFloat(target.target_amount)) continue; // already paid

          const dueDate    = new Date(target.due_date);
          const today      = new Date(scanDate);
          const daysUntil  = Math.ceil((dueDate - today) / 86400000);
          const daysOverdue = -daysUntil;

          if (daysUntil >= 0 && reminderDays.includes(daysUntil)) {
            await notification.send({
              type: 'payment_reminder', workspaceId: container.workspace_id,
              recipientIds: [p.workspace_member_id], referenceType: 'container', referenceId: container.id,
              variables: { amount: `${target.target_amount} ${target.target_currency}`, container: container.name, due_date: target.due_date },
              dedupKey: `reminder:${p.workspace_member_id}:${container.id}:${target.due_date}:${daysUntil}d`,
            });
          } else if (daysUntil < 0 && overdueDays.includes(daysOverdue)) {
            await notification.send({
              type: 'overdue_reminder', workspaceId: container.workspace_id,
              recipientIds: [p.workspace_member_id], referenceType: 'container', referenceId: container.id,
              variables: { container: container.name },
              dedupKey: `overdue:${p.workspace_member_id}:${container.id}:${target.due_date}:${daysOverdue}d`,
            });

            // Admin overdue summary
            const { data: admins } = await supabaseAdmin
              .from('workspace_members').select('id').eq('workspace_id', container.workspace_id).eq('role', 'admin').eq('is_active', true);

            // Count all overdue participants in this container
            const { data: allParticipants } = await supabaseAdmin
              .from('container_participants')
              .select('workspace_member_id, contributor_targets!inner(target_amount, due_date, is_current, cycle_id)')
              .eq('container_id', container.id)
              .eq('contributor_targets.is_current', true)
              .is('contributor_targets.cycle_id', null)
              .lt('contributor_targets.due_date', scanDate);

            if ((allParticipants || []).length) {
              await notification.send({
                type: 'overdue_summary_admin', workspaceId: container.workspace_id,
                recipientIds: (admins || []).map((a) => a.id),
                referenceType: 'container', referenceId: container.id,
                variables: { count: allParticipants.length, container: container.name },
                dedupKey: `overdue-summary:admin:${container.id}:${scanDate}:${daysOverdue}d`,
              });
            }
          }
        }
      }

      logger.info('Reminder scan complete', { scanDate });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Cycle Generation Worker ────────────────────────────────────────

function createCycleGenerationWorker() {
  return new Worker(
    'cycle-generation-queue',
    async (job) => {
      const { container_id, generate_months_ahead = 3 } = job.data;
      logger.info('Generating cycles', { container_id, generate_months_ahead });

      const { data: container } = await supabaseAdmin
        .from('containers').select('*').eq('id', container_id).eq('container_type', 'recurring').eq('status', 'active').is('deleted_at', null).maybeSingle();

      if (!container) return;

      const { data: lastCycle } = await supabaseAdmin
        .from('container_cycles').select('*').eq('container_id', container_id).order('cycle_number', { ascending: false }).limit(1).maybeSingle();

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

      while (nextStart <= cutoffDate) {
        let cycleEnd = new Date(nextStart);

        switch (container.recurrence_cadence) {
          case 'monthly':   cycleEnd.setMonth(cycleEnd.getMonth() + 1);              cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'quarterly': cycleEnd.setMonth(cycleEnd.getMonth() + 3);              cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'yearly':    cycleEnd.setFullYear(cycleEnd.getFullYear() + 1);        cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'custom':    cycleEnd.setDate(cycleEnd.getDate() + (container.recurrence_days || 30) - 1); break;
          default:          cycleEnd.setMonth(cycleEnd.getMonth() + 1);              cycleEnd.setDate(cycleEnd.getDate() - 1);
        }

        const cycleStartStr = nextStart.toISOString().split('T')[0];
        const cycleEndStr   = cycleEnd.toISOString().split('T')[0];

        // Check for pause_pool override
        const { data: pauseOverride } = await supabaseAdmin
          .from('pool_cycle_overrides').select('id').eq('container_id', container_id).eq('cycle_start', cycleStartStr).eq('override_type', 'pause_pool').maybeSingle();

        const status = pauseOverride ? 'skipped' : (nextStart <= today ? 'open' : 'upcoming');

        // Insert cycle (idempotent)
        const { data: cycleRow } = await supabaseAdmin
          .from('container_cycles')
          .upsert({ container_id, cycle_number: nextCycleNumber, cycle_start: cycleStartStr, cycle_end: cycleEndStr, status }, { onConflict: 'container_id,cycle_start', ignoreDuplicates: true })
          .select('id')
          .maybeSingle();

        if (cycleRow && status !== 'skipped') {
          const cycleId = cycleRow.id;

          const { data: participants } = await supabaseAdmin
            .from('container_participants')
            .select('id, workspace_member_id, contributor_targets(target_amount, target_currency, is_current, cycle_id)')
            .eq('container_id', container_id)
            .eq('money_enabled', true);

          for (const p of (participants || [])) {
            const { data: skipOverride } = await supabaseAdmin
              .from('pool_cycle_overrides').select('id').eq('container_id', container_id).eq('cycle_start', cycleStartStr).eq('override_type', 'skip_member').eq('member_id', p.workspace_member_id).maybeSingle();

            if (skipOverride) continue;

            const { data: adjustOverride } = await supabaseAdmin
              .from('pool_cycle_overrides').select('new_target, new_currency').eq('container_id', container_id).eq('cycle_start', cycleStartStr).eq('override_type', 'adjust_target').eq('member_id', p.workspace_member_id).maybeSingle();

            const baseTarget   = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
            const targetAmount  = adjustOverride?.new_target   || baseTarget?.target_amount;
            const targetCurrency = adjustOverride?.new_currency || baseTarget?.target_currency;

            if (targetAmount) {
              await supabaseAdmin.from('contributor_targets').upsert(
                { container_participant_id: p.id, container_id, workspace_member_id: p.workspace_member_id, cycle_id: cycleId, target_amount: targetAmount, target_currency: targetCurrency, due_date: cycleEndStr, set_by: container.created_by, is_current: true },
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
    },
    { connection: getRedis(), concurrency: 5 }
  );
}

// ── Cycle Lifecycle Worker ─────────────────────────────────────────

function createCycleLifecycleWorker() {
  return new Worker(
    'cycle-lifecycle-queue',
    async (job) => {
      const today = new Date().toISOString().split('T')[0];
      logger.info('Running cycle lifecycle', { today });

      // Open: upcoming cycles whose start date has arrived
      const { data: toOpen } = await supabaseAdmin
        .from('container_cycles').update({ status: 'open' }).eq('status', 'upcoming').lte('cycle_start', today).select('id, container_id');

      for (const cycle of (toOpen || [])) {
        const { data: container } = await supabaseAdmin.from('containers').select('workspace_id, name').eq('id', cycle.container_id).maybeSingle();
        if (!container) continue;

        const { data: participants } = await supabaseAdmin
          .from('container_participants')
          .select('workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id)')
          .eq('container_id', cycle.container_id)
          .eq('money_enabled', true);

        const recipientIds = (participants || []).map((p) => p.workspace_member_id);
        const first        = (participants || [])[0];
        const firstTarget  = (first?.contributor_targets || []).find((t) => t.cycle_id === cycle.id);

        await notification.send({
          type: 'cycle_started', workspaceId: container.workspace_id,
          recipientIds, referenceType: 'container', referenceId: cycle.container_id,
          variables: { container: container.name, amount: firstTarget ? `${firstTarget.target_amount} ${firstTarget.target_currency}` : 'TBD' },
        });
      }

      // Close: open cycles whose end date has passed
      const { data: toClose } = await supabaseAdmin
        .from('container_cycles')
        .select('*, containers!inner(workspace_id, carry_forward_unpaid)')
        .eq('status', 'open')
        .lt('cycle_end', today);

      for (const cycle of (toClose || [])) {
        if (cycle.containers?.carry_forward_unpaid) {
          // Find unpaid participants
          const { data: participants } = await supabaseAdmin
            .from('container_participants')
            .select('workspace_member_id, contributor_targets(target_amount, target_currency, cycle_id, is_current)')
            .eq('container_id', cycle.container_id)
            .eq('money_enabled', true);

          const { data: ledger } = await supabaseAdmin
            .from('ledger_entries').select('contributor_id, base_amount, status, cycle_id').eq('cycle_id', cycle.id).eq('status', 'confirmed');

          // Next open/upcoming cycle
          const { data: nextCycle } = await supabaseAdmin
            .from('container_cycles').select('id').eq('container_id', cycle.container_id).in('status', ['open','upcoming']).neq('id', cycle.id).order('cycle_number', { ascending: true }).limit(1).maybeSingle();

          for (const p of (participants || [])) {
            const cycleTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id && t.is_current);
            if (!cycleTarget) continue;

            const paid        = (ledger || []).filter((le) => le.contributor_id === p.workspace_member_id).reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
            const outstanding = parseFloat(cycleTarget.target_amount) - paid;

            if (outstanding > 0 && nextCycle?.id) {
              await supabaseAdmin.from('ledger_entries').insert({
                workspace_id: cycle.containers.workspace_id, container_id: cycle.container_id, cycle_id: nextCycle.id,
                entry_type: 'carry_forward', contributor_id: p.workspace_member_id,
                original_amount: outstanding, original_currency: cycleTarget.target_currency,
                base_amount: outstanding, status: 'confirmed',
                recorded_by: cycle.container_id, // system
                confirmed_at: new Date().toISOString(), confirmed_by: cycle.container_id,
                note: `Carried forward from cycle (closed ${cycle.cycle_end})`,
              });
            }
          }
        }

        await supabaseAdmin.from('container_cycles').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', cycle.id);

        const { getQueue } = require('../queues');
        await getQueue('cycle-generation-queue').add('generate-cycles', { container_id: cycle.container_id, generate_months_ahead: 3 });
      }

      logger.info('Cycle lifecycle complete', { opened: (toOpen || []).length, closed: (toClose || []).length });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Task Overdue Worker ────────────────────────────────────────────

function createTaskOverdueWorker() {
  return new Worker(
    'task-overdue-queue',
    async (job) => {
      const today = new Date().toISOString().split('T')[0];
      logger.info('Running task overdue check', { today });

      const { data: tasks } = await supabaseAdmin
        .from('container_tasks')
        .update({ status: 'overdue' })
        .eq('status', 'pending')
        .lt('due_date', today)
        .is('deleted_at', null)
        .select('id, container_id, title, assigned_to');

      for (const task of (tasks || [])) {
        const { data: container } = await supabaseAdmin.from('containers').select('workspace_id').eq('id', task.container_id).maybeSingle();
        if (!container) continue;

        const recipients = task.assigned_to ? [task.assigned_to] : [];

        const { data: admins } = await supabaseAdmin.from('workspace_members').select('id').eq('workspace_id', container.workspace_id).eq('role', 'admin').eq('is_active', true);
        for (const a of (admins || [])) { if (!recipients.includes(a.id)) recipients.push(a.id); }

        await notification.send({
          type: 'task_overdue', workspaceId: container.workspace_id,
          recipientIds: recipients, referenceType: 'task', referenceId: task.id,
          variables: { task_title: task.title, due_date: task.due_date || 'N/A' },
          dedupKey: `task-overdue:${task.id}:${today}`,
        });
      }

      logger.info('Task overdue check complete', { marked: (tasks || []).length });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Invite Cleanup Worker ──────────────────────────────────────────

function createInviteCleanupWorker() {
  return new Worker(
    'invite-cleanup-queue',
    async () => {
      const { data, error } = await supabaseAdmin
        .from('invite_links')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .is('used_at', null)
        .select('id');

      if (error) throw new Error(error.message);
      logger.info('Invite cleanup complete', { deleted: (data || []).length });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Engagement Check Worker ────────────────────────────────────────

function createEngagementCheckWorker() {
  return new Worker(
    'engagement-check-queue',
    async () => {
      logger.info('Running engagement check');

      const { data: members } = await supabaseAdmin
        .from('workspace_members')
        .select('id, workspace_id, last_active_at')
        .eq('is_proxy', false)
        .is('deleted_at', null)
        .eq('is_active', true);

      for (const m of (members || [])) {
        const [{ data: ledger }, { data: tasks }] = await Promise.all([
          supabaseAdmin.from('ledger_entries').select('confirmed_at').eq('contributor_id', m.id).eq('status', 'confirmed'),
          supabaseAdmin.from('container_tasks').select('completed_at').eq('assigned_to', m.id).eq('status', 'completed'),
        ]);

        const candidates = [
          m.last_active_at,
          ...(ledger  || []).map((le) => le.confirmed_at),
          ...(tasks   || []).map((t)  => t.completed_at),
        ].filter(Boolean);

        if (!candidates.length) continue;

        const latest = new Date(Math.max(...candidates.map((d) => new Date(d)))).toISOString();

        await supabaseAdmin
          .from('workspace_members')
          .update({ last_active_at: latest })
          .eq('id', m.id)
          .or(`last_active_at.is.null,last_active_at.lt.${latest}`);
      }

      logger.info('Engagement check complete', { processed: (members || []).length });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

module.exports = { createReminderWorker, createCycleGenerationWorker, createCycleLifecycleWorker, createTaskOverdueWorker, createInviteCleanupWorker, createEngagementCheckWorker };
