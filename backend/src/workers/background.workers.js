// src/workers/background_workers.js
const { Worker }        = require('bullmq');
const { supabaseAdmin } = require('../config/supabase');
const { getRedis }      = require('../config/redis');
const { getQueue }      = require('../queues');
const notification      = require('../services/notification.service');
const logger            = require('../utils/logger');

// ── Reminder Worker ────────────────────────────────────────────────

function createReminderWorker() {
  return new Worker(
    'reminder-queue',
    async () => {
      const scanDate = new Date().toISOString().split('T')[0];
      logger.info('Running reminder scan', { scanDate });

      // Upcoming contributions due within the next 7 days
      const soon = new Date();
      soon.setDate(soon.getDate() + 7);
      const soonStr = soon.toISOString().split('T')[0];

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
      }

      // Overdue contributions (past due date, not yet paid)
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

        await notification.send({
          type:          'overdue_reminder',
          workspaceId:   target.container.workspace_id,
          recipientIds:  [target.workspace_member_id],
          referenceType: 'container',
          referenceId:   target.container.id,
          variables:     { container: target.container.name },
          dedupKey:      `overdue_reminder:${target.id}:${scanDate}`,
        });
      }

      logger.info('Reminder scan complete', { scanDate });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Cycle Generation Worker ────────────────────────────────────────
//
// Batch improvement: all pool_cycle_overrides for the container are fetched
// in a single upfront query and stored in lookup Maps. This eliminates the
// original O(participants × cycles) database round trips inside the loop.

function createCycleGenerationWorker() {
  return new Worker(
    'cycle-generation-queue',
    async (job) => {
      const { container_id, generate_months_ahead = 3 } = job.data;
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

      // Batch-fetch ALL overrides for this container upfront.
      // Builds lookup maps so the while-loop runs zero extra DB queries per cycle.
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

      // Fetch participants once (also outside the loop)
      const { data: participants } = await supabaseAdmin
        .from('container_participants')
        .select('id, workspace_member_id, contributor_targets(target_amount, target_currency, is_current, cycle_id)')
        .eq('container_id', container_id)
        .eq('money_enabled', true);

      while (nextStart <= cutoffDate) {
        let cycleEnd = new Date(nextStart);

        switch (container.recurrence_cadence) {
          case 'monthly':   cycleEnd.setMonth(cycleEnd.getMonth() + 1);           cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'quarterly': cycleEnd.setMonth(cycleEnd.getMonth() + 3);           cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'yearly':    cycleEnd.setFullYear(cycleEnd.getFullYear() + 1);     cycleEnd.setDate(cycleEnd.getDate() - 1); break;
          case 'custom':    cycleEnd.setDate(cycleEnd.getDate() + (container.recurrence_days || 30) - 1); break;
          default:          cycleEnd.setMonth(cycleEnd.getMonth() + 1);           cycleEnd.setDate(cycleEnd.getDate() - 1);
        }

        const cycleStartStr = nextStart.toISOString().split('T')[0];
        const cycleEndStr   = cycleEnd.toISOString().split('T')[0];

        // Use pre-fetched pause override map — no DB query
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
            // Use pre-fetched skip override map — no DB query
            if (skipOverrides.has(`${cycleStartStr}:${p.workspace_member_id}`)) continue;

            // Use pre-fetched adjust override map — no DB query
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
    },
    { connection: getRedis(), concurrency: 5 }
  );
}

// ── Cycle Lifecycle Worker ─────────────────────────────────────────
//
// Fix: cycle_started notification now sends each participant their own
// target amount instead of sending participant #1's amount to everyone.

function createCycleLifecycleWorker() {
  return new Worker(
    'cycle-lifecycle-queue',
    async () => {
      const today = new Date().toISOString().split('T')[0];
      logger.info('Running cycle lifecycle', { today });

      // Open: upcoming cycles whose start date has arrived
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

        // Send each participant their own target amount (not a shared first-member amount)
        for (const p of (participants || [])) {
          const recipientTarget = (p.contributor_targets || []).find((t) => t.cycle_id === cycle.id);

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
        }
      }

      // Close: open cycles whose end date has passed
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

      logger.info('Cycle lifecycle complete', {
        opened: (toOpen  || []).length,
        closed: (toClose || []).length,
      });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Task Overdue Worker ────────────────────────────────────────────

function createTaskOverdueWorker() {
  return new Worker(
    'task-overdue-queue',
    async () => {
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
        const { data: container } = await supabaseAdmin
          .from('containers')
          .select('workspace_id')
          .eq('id', task.container_id)
          .maybeSingle();

        if (!container) continue;

        const recipients = task.assigned_to ? [task.assigned_to] : [];

        const { data: admins } = await supabaseAdmin
          .from('workspace_members')
          .select('id')
          .eq('workspace_id', container.workspace_id)
          .eq('role', 'admin')
          .eq('is_active', true);

        for (const a of (admins || [])) {
          if (!recipients.includes(a.id)) recipients.push(a.id);
        }

        await notification.send({
          type:          'task_overdue',
          workspaceId:   container.workspace_id,
          recipientIds:  recipients,
          referenceType: 'task',
          referenceId:   task.id,
          variables:     { task_title: task.title, due_date: task.due_date || 'N/A' },
          dedupKey:      `task-overdue:${task.id}:${today}`,
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
//
// Batch improvement: fetches all ledger entries and tasks for all active
// members in two queries (instead of two per member), then processes
// entirely in memory. Reduces from O(2N+1) queries to 3 total.

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

      if (!(members || []).length) {
        logger.info('Engagement check complete', { processed: 0 });
        return;
      }

      const memberIds = members.map((m) => m.id);

      // Two batch queries instead of 2N
      const [{ data: allLedger }, { data: allTasks }] = await Promise.all([
        supabaseAdmin
          .from('ledger_entries')
          .select('contributor_id, confirmed_at')
          .in('contributor_id', memberIds)
          .eq('status', 'confirmed'),
        supabaseAdmin
          .from('container_tasks')
          .select('assigned_to, completed_at')
          .in('assigned_to', memberIds)
          .eq('status', 'completed'),
      ]);

      // Build lookup maps keyed by member ID
      const ledgerByMember = new Map();
      for (const le of (allLedger || [])) {
        if (!ledgerByMember.has(le.contributor_id)) ledgerByMember.set(le.contributor_id, []);
        ledgerByMember.get(le.contributor_id).push(le.confirmed_at);
      }

      const tasksByMember = new Map();
      for (const t of (allTasks || [])) {
        if (!tasksByMember.has(t.assigned_to)) tasksByMember.set(t.assigned_to, []);
        tasksByMember.get(t.assigned_to).push(t.completed_at);
      }

      // Update each member's last_active_at in parallel
      const updates = [];

      for (const m of members) {
        const candidates = [
          m.last_active_at,
          ...(ledgerByMember.get(m.id) || []),
          ...(tasksByMember.get(m.id)  || []),
        ].filter(Boolean);

        if (!candidates.length) continue;

        const latest = new Date(Math.max(...candidates.map((d) => new Date(d)))).toISOString();

        updates.push(
          supabaseAdmin
            .from('workspace_members')
            .update({ last_active_at: latest })
            .eq('id', m.id)
            .or(`last_active_at.is.null,last_active_at.lt.${latest}`)
        );
      }

      await Promise.all(updates);

      logger.info('Engagement check complete', { processed: members.length });
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

// ── Notification Outbox Worker ─────────────────────────────────────
//
// Safety net for the notification pipeline: scans for delivery records
// stuck in 'pending' or 'failed' (for external channels) for more than
// 5 minutes and re-enqueues them. This closes the gap where a queue.add
// failure would otherwise silently drop a notification.

function createNotificationOutboxWorker() {
  return new Worker(
    'notification-outbox-queue',
    async () => {
      const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      const { data: stale } = await supabaseAdmin
        .from('notification_deliveries')
        .select(`
          id, channel,
          notification_id,
          notifications(
            id, title, body, workspace_id, reference_type, reference_id,
            recipient_id,
            workspace_members!recipient_id(
              is_proxy,
              users:user_id(id, push_token, push_token_platform, push_enabled, email, email_digest_enabled)
            )
          )
        `)
        .in('status', ['pending', 'failed'])
        .neq('channel', 'in_app')
        .lt('created_at', staleThreshold)
        .limit(50);

      if (!(stale || []).length) return;

      const notificationQueue = getQueue('notification-queue');

      for (const delivery of stale) {
        try {
          const notif = delivery.notifications;
          if (!notif) continue;

          const recipient = notif.workspace_members;
          if (recipient?.is_proxy) continue; // proxy members never get external channels

          const rawUser = recipient?.users;
          const user    = Array.isArray(rawUser) ? rawUser[0] : rawUser;

          await notificationQueue.add(
            `deliver-${delivery.channel}`,
            {
              notification_id:      delivery.notification_id,
              delivery_id:          delivery.id,
              channel:              delivery.channel,
              recipient_user_id:    user?.id,
              push_token:           user?.push_token,
              push_token_platform:  user?.push_token_platform,
              push_enabled:         user?.push_enabled,
              email:                user?.email,
              email_digest_enabled: user?.email_digest_enabled,
              title:                notif.title,
              body:                 notif.body,
              reference_type:       notif.reference_type,
              reference_id:         notif.reference_id,
              workspace_id:         notif.workspace_id,
            },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
          );

          // Reset status to pending so the delivery worker can update it to delivered
          await supabaseAdmin
            .from('notification_deliveries')
            .update({ status: 'pending' })
            .eq('id', delivery.id);

          logger.info('Re-enqueued stale notification delivery', { deliveryId: delivery.id, channel: delivery.channel });
        } catch (err) {
          logger.error('Failed to re-enqueue stale delivery', { deliveryId: delivery.id, error: err.message });
        }
      }
    },
    { connection: getRedis(), concurrency: 1 }
  );
}

module.exports = {
  createReminderWorker,
  createCycleGenerationWorker,
  createCycleLifecycleWorker,
  createTaskOverdueWorker,
  createInviteCleanupWorker,
  createEngagementCheckWorker,
  createNotificationOutboxWorker,
};
