// src/services/engagement.service.js
//
// Single, already-optimized implementation shared by both call sites
// (background.workers.js's engagement-check worker and
// member.controller.js#getMemberEngagement): batch-fetches ledger
// entries and completed tasks for a set of workspace_member ids in
// exactly 2 queries, regardless of member count, and returns lookup Maps
// keyed by member id.

const { supabaseAdmin } = require('../config/supabase');

async function fetchEngagementData(memberIds) {
  if (!memberIds.length) return { ledgerByMember: new Map(), tasksByMember: new Map() };

  const [{ data: allLedger }, { data: allTasks }] = await Promise.all([
    supabaseAdmin
      .from('ledger_entries')
      .select('contributor_id, status, confirmed_at')
      .in('contributor_id', memberIds),
    supabaseAdmin
      .from('container_tasks')
      .select('assigned_to, status, completed_at')
      .in('assigned_to', memberIds)
      .eq('status', 'completed'),
  ]);

  const ledgerByMember = new Map();
  for (const le of (allLedger || [])) {
    if (!ledgerByMember.has(le.contributor_id)) ledgerByMember.set(le.contributor_id, []);
    ledgerByMember.get(le.contributor_id).push(le);
  }

  const tasksByMember = new Map();
  for (const t of (allTasks || [])) {
    if (!tasksByMember.has(t.assigned_to)) tasksByMember.set(t.assigned_to, []);
    tasksByMember.get(t.assigned_to).push(t);
  }

  return { ledgerByMember, tasksByMember };
}

/**
 * Computes per-member engagement stats for the dashboard/engagement API
 * endpoint. `members` entries must include at least { id, display_name,
 * last_active_at }.
 */
async function computeEngagement(members) {
  const memberIds = members.map((m) => m.id);
  const { ledgerByMember, tasksByMember } = await fetchEngagementData(memberIds);
  const now = new Date();

  return members.map((m) => {
    const ledger           = ledgerByMember.get(m.id) || [];
    const confirmedLedger  = ledger.filter((le) => le.status === 'confirmed');
    const pendingLedger    = ledger.filter((le) => le.status === 'pending');
    const tasks            = tasksByMember.get(m.id) || [];

    const activityDates = [
      m.last_active_at,
      ...confirmedLedger.map((le) => le.confirmed_at),
      ...tasks.map((t) => t.completed_at),
    ].filter(Boolean);

    const lastActivity  = activityDates.length
      ? new Date(Math.max(...activityDates.map((d) => new Date(d))))
      : null;
    const daysSince     = lastActivity ? Math.floor((now - lastActivity) / 86400000) : Infinity;

    let engagementLevel = 'inactive';
    if (daysSince <= 30)      engagementLevel = 'active';
    else if (daysSince <= 90) engagementLevel = 'quiet';

    return {
      member_id:                     m.id,
      display_name:                  m.display_name,
      last_activity:                 lastActivity ? lastActivity.toISOString().split('T')[0] : null,
      confirmed_contributions_count: confirmedLedger.length,
      pending_contributions_count:   pendingLedger.length,
      overdue_count:                 0,
      engagement_level:              engagementLevel,
    };
  });
}

module.exports = { fetchEngagementData, computeEngagement };
