// src/services/audit_log.service.js
//
// Named audit_log.service.js (not audit.service.js) because
// services/audit.service.js already exists — it's the fire-and-forget
// audit.log()/fromReq() writer used by every other controller. This file
// is a distinct concern: the paginated audit-log *read* view and its CSV
// export.
//
// The shared applyAuditLogFilters() helper keeps the paginated view and
// the CSV export from drifting out of sync.

const { supabaseAdmin } = require('../config/supabase');
const { getPagination } = require('../utils/pagination');

function applyAuditLogFilters(query, { action, actor_member_id, from, to }) {
  if (action)          query = query.eq('action', action);
  if (actor_member_id) query = query.eq('actor_member_id', actor_member_id);
  if (from)            query = query.gte('created_at', from);
  if (to)              query = query.lte('created_at', to);
  return query;
}

/**
 * Paginated audit log for a workspace, with actor display names resolved.
 * @returns {Promise<{entries: Array, count: number, page: number, perPage: number}>}
 */
async function getAuditLog({ workspaceId, filters, page, perPage, offset }) {
  let query = supabaseAdmin
    .from('audit_log')
    .select('*, actor_member:workspace_members!actor_member_id(display_name)', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range(offset, offset + perPage - 1);

  query = applyAuditLogFilters(query, filters);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const entries = (data || []).map((e) => ({
    ...e,
    actor_name:   e.actor_member?.display_name || 'System',
    actor_member: undefined,
  }));

  return { entries, count: count || 0, page, perPage };
}

/**
 * CSV export of the audit log for a workspace, same filters as
 * getAuditLog. Returns a raw CSV string.
 */
async function exportAuditLogCsv({ workspaceId, filters, limit = 1000 }) {
  let query = supabaseAdmin
    .from('audit_log')
    .select('*, actor_member:workspace_members!actor_member_id(display_name)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit), 10000));

  query = applyAuditLogFilters(query, filters);

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

  return csv;
}

module.exports = {
  getAuditLog,
  exportAuditLogCsv,
};
