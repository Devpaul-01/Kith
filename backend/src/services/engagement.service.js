// src/services/engagement.service.js
//
// Single, already-optimized implementation shared by both call sites
// (background.workers.js's engagement-check worker and
// member.controller.js#getMemberEngagement): batch-fetches ledger
// entries and completed tasks for a set of workspace_member ids in
// exactly 2 queries, regardless of member count, and returns lookup Maps
// keyed by member id.

const { supabaseAdmin } = require('../config/supabase');
const { PAID_STATUSES } = require('../constants/ledger-status');
const { AppError } = require('../utils/errors');

async function fetchEngagementData(memberIds, { workspaceId } = {}) {
  if (!memberIds.length) return { ledgerByMember: new Map(), tasksByMember: new Map() };

  // The member endpoint passes workspace scope. The background check can still
  // batch members from several workspaces using the original member-ID scope.
  let ledgerQuery = supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, status, confirmed_at')
    .in('contributor_id', memberIds);
  if (workspaceId !== undefined) ledgerQuery = ledgerQuery.eq('workspace_id', workspaceId);

  let tasksQuery = supabaseAdmin
    .from('container_tasks')
    .select(workspaceId !== undefined
      ? 'assigned_to, status, completed_at, containers!container_tasks_container_id_fkey!inner(workspace_id)'
      : 'assigned_to, status, completed_at')
    .in('assigned_to', memberIds)
    .eq('status', 'completed');
  if (workspaceId !== undefined) tasksQuery = tasksQuery.eq('containers.workspace_id', workspaceId);

  const [{ data: allLedger, error: ledgerError }, { data: allTasks, error: taskError }] = await Promise.all([ledgerQuery, tasksQuery]);
  if (ledgerError || taskError || !Array.isArray(allLedger) || !Array.isArray(allTasks)) {
    throw new AppError('Member engagement is unavailable. Please try again.', 503, 'ENGAGEMENT_UNAVAILABLE');
  }

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
async function computeEngagement(members, options) {
  const memberIds = members.map((m) => m.id);
  const { ledgerByMember, tasksByMember } = await fetchEngagementData(memberIds, options);
  const now = new Date();

  return members.map((m) => {
    const ledger           = ledgerByMember.get(m.id) || [];
    // A resolved dispute is still a real, settled contribution (and
    // confirmed_at was already set when it was first confirmed) — it
    // should count toward "last activity" and the confirmed count same
    // as any other paid entry.
    const confirmedLedger  = ledger.filter((le) => PAID_STATUSES.includes(le.status));
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
