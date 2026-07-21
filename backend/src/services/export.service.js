// src/services/export.service.js
const { stringify }     = require('csv-stringify/sync');
const { supabaseAdmin } = require('../config/supabase');

async function exportLedgerCSV({ workspaceId, containerId, from, to }) {
  let query = supabaseAdmin
    .from('ledger_entries')
    .select(`
      id, entry_type, original_amount, original_currency,
      base_amount, payment_method, status, note,
      recorded_at, confirmed_at,
      contributor:workspace_members!contributor_id ( display_name ),
      recorded_by_member:workspace_members!recorded_by ( display_name ),
      container:containers!container_id ( name )
    `)
    .eq('workspace_id', workspaceId)
    .order('recorded_at', { ascending: false });

  if (containerId) query = query.eq('container_id', containerId);
  if (from)        query = query.gte('recorded_at', from);
  if (to)          query = query.lte('recorded_at', to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data || []).map((le) => ({
    id:                le.id,
    container_name:    le.container?.name,
    entry_type:        le.entry_type,
    contributor_name:  le.contributor?.display_name,
    original_amount:   le.original_amount,
    original_currency: le.original_currency,
    base_amount:       le.base_amount,
    payment_method:    le.payment_method,
    status:            le.status,
    note:              le.note,
    recorded_by_name:  le.recorded_by_member?.display_name,
    recorded_at:       le.recorded_at,
    confirmed_at:      le.confirmed_at,
  }));

  return stringify(rows, {
    header: true,
    columns: [
      { key: 'id',                header: 'Entry ID' },
      { key: 'container_name',    header: 'Container' },
      { key: 'entry_type',        header: 'Type' },
      { key: 'contributor_name',  header: 'Contributor' },
      { key: 'original_amount',   header: 'Original Amount' },
      { key: 'original_currency', header: 'Original Currency' },
      { key: 'base_amount',       header: 'Base Amount' },
      { key: 'payment_method',    header: 'Payment Method' },
      { key: 'status',            header: 'Status' },
      { key: 'note',              header: 'Note' },
      { key: 'recorded_by_name',  header: 'Recorded By' },
      { key: 'recorded_at',       header: 'Recorded At' },
      { key: 'confirmed_at',      header: 'Confirmed At' },
    ],
  });
}

async function exportTasksCSV({ containerId, assignedTo = null }) {
  let query = supabaseAdmin
    .from('container_tasks')
    .select(`
      id, title, description, due_date, status, completed_at, completion_note,
      assigned_to_member:workspace_members!assigned_to ( display_name )
    `)
    .eq('container_id', containerId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  // Shared by both the admin and member-scoped export paths, via the
  // assignedTo filter, instead of two independently-maintained CSV
  // builders.
  if (assignedTo) query = query.eq('assigned_to', assignedTo);

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  const rows = (data || []).map((t) => ({
    id:               t.id,
    title:            t.title,
    description:      t.description,
    assigned_to_name: t.assigned_to_member?.display_name,
    due_date:         t.due_date,
    status:           t.status,
    completed_at:     t.completed_at,
    completion_note:  t.completion_note,
  }));

  return stringify(rows, {
    header: true,
    columns: [
      { key: 'id',               header: 'Task ID' },
      { key: 'title',            header: 'Title' },
      { key: 'description',      header: 'Description' },
      { key: 'assigned_to_name', header: 'Assigned To' },
      { key: 'due_date',         header: 'Due Date' },
      { key: 'status',           header: 'Status' },
      { key: 'completed_at',     header: 'Completed At' },
      { key: 'completion_note',  header: 'Completion Note' },
    ],
  });
}

module.exports = { exportLedgerCSV, exportTasksCSV };
