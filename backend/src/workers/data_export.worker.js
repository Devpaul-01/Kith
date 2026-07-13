// src/workers/data_export.worker.js
//
// Issue 21: Data Export Worker
// Processes 'export-user-data' jobs queued by POST /v1/auth/data-export.
// Fetches the user's ledger entries and task data across their workspaces,
// generates a JSON/CSV summary, and emails it to the user.
//
// For production you may want to upload the file to Supabase Storage and
// send a signed download link instead of attaching CSV directly to the email.

const { Worker }        = require('bullmq');
const { getRedis }      = require('../config/redis');
const { supabaseAdmin } = require('../config/supabase');
const { getResend }     = require('../config/resend');
const logger            = require('../utils/logger');

function createDataExportWorker() {
  return new Worker(
    'data-export-queue',
    async (job) => {
      const { userId, userEmail, workspaceIds = [] } = job.data;
      logger.info('Processing data export', { userId, workspaceCount: workspaceIds.length });

      // ── 1. Fetch user profile ────────────────────────────────────
      const { data: user } = await supabaseAdmin
        .from('users')
        .select('id, email, full_name, country_of_residence, timezone, preferred_language, created_at')
        .eq('id', userId)
        .maybeSingle();

      // ── 2. Resolve this user's workspace_members rows ────────────
      //
      // Issue C1 fix: ledger_entries.contributor_id and
      // container_tasks.assigned_to both store workspace_members.id, NOT
      // users.id — every other read of these tables in the codebase
      // (ledger.controller.js, member.controller.js, etc.) resolves
      // workspace_members first. This worker's task-export query already
      // did that resolution correctly; the ledger-export query previously
      // filtered directly on `contributor_id = userId` (a users.id) and
      // therefore matched zero rows for every single export, silently. The
      // resolution is now done once, up front, and reused by both queries.
      const { data: memberRows, error: memberErr } = await supabaseAdmin
        .from('workspace_members')
        .select('id')
        .eq('user_id', userId)
        .in('workspace_id', workspaceIds)
        .eq('is_active', true);

      if (memberErr) {
        logger.error('Data export: member resolution query failed', { userId, error: memberErr.message });
        throw new Error(memberErr.message);
      }

      const memberIds = (memberRows || []).map((m) => m.id);

      // ── 3. Fetch ledger entries ──────────────────────────────────
      let ledgerEntries = [];
      if (memberIds.length > 0) {
        const { data: ledgerData, error: ledgerErr } = await supabaseAdmin
          .from('ledger_entries')
          .select(`
            id, entry_type, original_amount, original_currency,
            base_amount, payment_method, status, note,
            recorded_at, confirmed_at,
            container:containers!container_id(name),
            workspace:workspaces!workspace_id(name)
          `)
          .in('contributor_id', memberIds)
          .in('workspace_id', workspaceIds)
          .order('recorded_at', { ascending: false });

        if (ledgerErr) {
          logger.error('Data export: ledger query failed', { userId, error: ledgerErr.message });
          throw new Error(ledgerErr.message);
        }

        ledgerEntries = ledgerData || [];
      }

      // ── 4. Fetch task assignments ────────────────────────────────
      let taskRows = [];
      if (memberIds.length > 0) {
        const { data: tasks } = await supabaseAdmin
          .from('container_tasks')
          .select('id, title, status, due_date, completed_at, completion_note, created_at, container:containers!container_id(name)')
          .in('assigned_to', memberIds)
          .is('deleted_at', null)
          .order('created_at', { ascending: false });

        taskRows = tasks || [];
      }

      // ── 5. Build CSV payloads ────────────────────────────────────
      const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

      const ledgerCsvHeader = 'Workspace,Container,Type,Amount,Currency,Base Amount,Payment Method,Status,Note,Recorded At,Confirmed At';
      const ledgerCsvRows   = ledgerEntries.map((le) => [
        escape(le.workspace?.name),
        escape(le.container?.name),
        le.entry_type,
        le.original_amount,
        le.original_currency,
        le.base_amount,
        escape(le.payment_method),
        le.status,
        escape(le.note),
        le.recorded_at || '',
        le.confirmed_at || '',
      ].join(','));

      const ledgerCsv = [ledgerCsvHeader, ...ledgerCsvRows].join('\n');

      const taskCsvHeader = 'Container,Title,Status,Due Date,Completed At,Completion Note,Created At';
      const taskCsvRows   = taskRows.map((t) => [
        escape(t.container?.name),
        escape(t.title),
        t.status,
        t.due_date      || '',
        t.completed_at  || '',
        escape(t.completion_note),
        t.created_at,
      ].join(','));

      const taskCsv = [taskCsvHeader, ...taskCsvRows].join('\n');

      // ── 6. Send email ────────────────────────────────────────────
      const resend = getResend();
      if (!resend) {
        logger.warn('Data export: Resend not configured — export generated but not emailed', { userId });
        return;
      }

      const displayName = user?.full_name || userEmail;
      const now         = new Date().toISOString().split('T')[0];

      await resend.emails.send({
        from:    process.env.EMAIL_FROM || 'Kith <noreply@kith.app>',
        to:      userEmail,
        subject: `Your Kith data export — ${now}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
            <h2 style="color:#1a1a1a">Your Kith data export</h2>
            <p style="color:#444">Hi ${escapeHtml(displayName)},</p>
            <p style="color:#444">
              Your data export is attached. It includes:
            </p>
            <ul style="color:#444">
              <li>${ledgerEntries.length} ledger entries (contributions)</li>
              <li>${taskRows.length} task assignments</li>
            </ul>
            <p style="color:#888;font-size:12px">
              This export covers all workspaces you were an active member of at the time of request.
              Data is accurate as of ${now}.
            </p>
            <hr style="border:1px solid #eee;margin:20px 0">
            <p style="color:#888;font-size:12px">Kith — Family Finance Coordinator</p>
          </div>
        `,
        attachments: [
          {
            filename: `kith-contributions-${now}.csv`,
            content:  Buffer.from(ledgerCsv).toString('base64'),
          },
          {
            filename: `kith-tasks-${now}.csv`,
            content:  Buffer.from(taskCsv).toString('base64'),
          },
        ],
      });

      logger.info('Data export emailed', {
        userId,
        userEmail,
        ledgerCount: ledgerEntries.length,
        taskCount:   taskRows.length,
      });
    },
    {
      connection:  getRedis(),
      concurrency: 2,  // exports are I/O heavy — keep concurrency low
    }
  );
}

// Shared with notification.worker.js's escaping approach (Issue M12) —
// displayName here ultimately comes from the user's own profile, lower
// risk than container/task names, but escaped for consistency since it's
// interpolated into an HTML email body.
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = { createDataExportWorker };
