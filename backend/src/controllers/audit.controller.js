// src/controllers/audit.controller.js
//
// Extracted from workspace.controller.js (audit finding 3.6): the
// paginated audit-log view and its CSV export share one filter-building
// helper (applyAuditLogFilters) so the two can never drift out of sync —
// this pairing is why they're kept together in their own file rather than
// merged into workspace.controller.js or dashboard.controller.js.

const { supabaseAdmin } = require('../config/supabase');
const { success, paginate } = require('../utils/response');
const { getPagination } = require('../utils/pagination');

// ── Audit Log ──────────────────────────────────────────────────────
//
// Issue M15 fix: getAuditLog and exportAuditLog previously duplicated the
// same filter-building block (action/actor_member_id/from/to) verbatim.
// Extracted into applyAuditLogFilters() so the filtering logic can't drift
// between the paginated view and the CSV export.

function applyAuditLogFilters(query, { action, actor_member_id, from, to }) {
  if (action)          query = query.eq('action', action);
  if (actor_member_id) query = query.eq('actor_member_id', actor_member_id);
  if (from)            query = query.gte('created_at', from);
  if (to)              query = query.lte('created_at', to);
  return query;
}

async function getAuditLog(req, res, next) {
  try {
    const { workspaceId }            = req.params;
    const { page, perPage, offset }  = getPagination(req.query);

    let query = supabaseAdmin
      .from('audit_log')
      .select('*, actor_member:workspace_members!actor_member_id(display_name)', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .range(offset, offset + perPage - 1);

    query = applyAuditLogFilters(query, req.query);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    const entries = (data || []).map((e) => ({
      ...e,
      actor_name:   e.actor_member?.display_name || 'System',
      actor_member: undefined,
    }));

    paginate(res, { entries }, count || 0, page, perPage);
  } catch (err) { next(err); }
}

async function exportAuditLog(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { limit = 1000 } = req.query;

    let query = supabaseAdmin
      .from('audit_log')
      .select('*, actor_member:workspace_members!actor_member_id(display_name)')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(Math.min(parseInt(limit), 10000));

    query = applyAuditLogFilters(query, req.query);

    const { data } = await query;

    const headers = ['Date', 'Action', 'Actor', 'Target Type', 'Target ID', 'Metadata'];
    const rows    = (data || []).map((entry) => [
      entry.created_at,
      entry.action,
      entry.actor_member?.display_name || 'System',
      entry.target_type  || '',
      entry.target_id    || '',
      JSON.stringify(entry.metadata || {}),
    ]);

    const csv = [headers.join(','), ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

// ── Overdue Summary ────────────────────────────────────────────────

module.exports = {
  getAuditLog,
  exportAuditLog,
};
