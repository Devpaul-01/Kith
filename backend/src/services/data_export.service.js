// src/services/data_export.service.js
//
// Preserves the member resolution fix: workspace_members resolution
// happens once, up front, and is reused by both the ledger and task
// queries (ledger_entries.contributor_id and container_tasks.assigned_to
// both store workspace_members.id, not users.id).

const { supabaseAdmin } = require('../config/supabase');
const { getResend }     = require('../config/resend');
const logger            = require('../utils/logger');

function escapeCsv(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// displayName here ultimately comes from the user's own profile — lower
// risk than container/task names, but escaped for consistency since
// it's interpolated into an HTML email body.
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function processDataExport({ userId, userEmail, workspaceIds = [] }) {
  logger.info('Processing data export', { userId, workspaceCount: workspaceIds.length });

  // ── 1. Fetch user profile ────────────────────────────────────
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, country_of_residence, timezone, preferred_language, created_at')
    .eq('id', userId)
    .maybeSingle();

  // ── 2. Resolve this user's workspace_members rows ────────────
  //
  // Resolved once, up front, and reused by both the ledger-export and
  // task-export queries below.
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
  const ledgerCsvHeader = 'Workspace,Container,Type,Amount,Currency,Base Amount,Payment Method,Status,Note,Recorded At,Confirmed At';
  const ledgerCsvRows   = ledgerEntries.map((le) => [
    escapeCsv(le.workspace?.name),
    escapeCsv(le.container?.name),
    le.entry_type,
    le.original_amount,
    le.original_currency,
    le.base_amount,
    escapeCsv(le.payment_method),
    le.status,
    escapeCsv(le.note),
    le.recorded_at || '',
    le.confirmed_at || '',
  ].join(','));

  const ledgerCsv = [ledgerCsvHeader, ...ledgerCsvRows].join('\n');

  const taskCsvHeader = 'Container,Title,Status,Due Date,Completed At,Completion Note,Created At';
  const taskCsvRows   = taskRows.map((t) => [
    escapeCsv(t.container?.name),
    escapeCsv(t.title),
    t.status,
    t.due_date      || '',
    t.completed_at  || '',
    escapeCsv(t.completion_note),
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
}

module.exports = { processDataExport };
