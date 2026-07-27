// src/services/dashboard.service.js
//
// All aggregation/shaping logic for the workspace dashboard lives here.
// The controller only parses req, calls these functions, and responds.
//
// Caching: the expensive, role-shared portion of getDashboardData() is
// cached in Redis for TTL.DASHBOARD_CACHE_SECONDS (see
// services/dashboard-cache.service.js for the full rationale and the
// invalidation strategy). The per-member unread-notification count is
// deliberately excluded from the cached blob and fetched fresh on every
// call — it's a single indexed count query, cheap enough that caching it
// isn't worth the staleness/per-member cache-key-fanout tradeoff.

const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');
const { describeAuditAction } = require('../constants/audit-actions');
const { computeEngagement } = require('./engagement.service');
const {
  getCachedDashboard, setCachedDashboard,
  getCachedOverdueSummary, setCachedOverdueSummary,
} = require('./dashboard-cache.service');

async function getUnreadNotificationCount(memberId) {
  if (!memberId) return 0;
  const { count, error } = await supabaseAdmin
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_id', memberId)
    .eq('is_read', false);

  if (error) {
    logger.warn('Dashboard unread-count query error', { memberId, error: error.message });
    return 0;
  }
  return count || 0;
}

/**
 * Builds the workspace-wide, role-shared portion of the dashboard
 * payload: summary counts, active events, recurring pools, upcoming
 * deadlines, pending confirmations (admin only), and recent activity.
 * Does NOT include per-member fields (unread counts) — see caller.
 */
async function buildSharedDashboardPayload({ workspaceId, isAdmin }) {
  const today14 = new Date();
  today14.setDate(today14.getDate() + 14);
  const todayStr   = new Date().toISOString().split('T')[0];
  const today14Str = today14.toISOString().split('T')[0];

  const pendingConfirmationsQuery = isAdmin
    ? supabaseAdmin
        .from('ledger_entries')
        .select('*, contributor:workspace_members!contributor_id(display_name), recorded_by_member:workspace_members!recorded_by(display_name)')
        .eq('workspace_id', workspaceId)
        .in('status', ['pending', 'proof_uploaded'])
        .order('recorded_at', { ascending: true })
        .limit(10)
    : Promise.resolve({ data: [] });

  // ── Open disputes count (admin only) ──
  const openDisputesQuery = isAdmin
    ? supabaseAdmin
        .from('disputes')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'open')
    : Promise.resolve({ count: 0 });

  // ── Recent milestones ──
  const recentMilestonesQuery = supabaseAdmin
    .from('milestones')
    .select('id, title, description, milestone_date, milestone_type, photos')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('milestone_date', { ascending: false })
    .limit(3);

  const [
    { data: allMembers,    error: membersError },
    { data: rawContainers, error: containersError },
    { data: pools,         error: poolsError },
    { data: targetsData,   error: targetsError },
    { data: activity,      error: activityError },
    { data: pending },
    { count: openDisputesCount },
    { data: recentMilestones, error: milestonesError },
  ] = await Promise.all([
    supabaseAdmin
      .from('workspace_members')
      .select('role, is_active, is_proxy, deleted_at')
      .eq('workspace_id', workspaceId),

    supabaseAdmin
      .from('containers')
      .select('id, name, subtitle, event_date, enable_money, enable_tasks, budget_target, budget_currency, container_participants(id), ledger_entries(base_amount, status)')
      .eq('workspace_id', workspaceId)
      .eq('container_type', 'event')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('event_date', { ascending: true, nullsFirst: false }),

    supabaseAdmin
      .from('containers')
      .select('id, name, container_cycles(id, cycle_start, cycle_end, status, total_expected, total_collected)')
      .eq('workspace_id', workspaceId)
      .eq('container_type', 'recurring')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),

    supabaseAdmin
      .from('contributor_targets')
      .select(`
        target_amount,
        target_currency,
        due_date,
        container_participant_id,
        container_id
      `)
      .eq('is_current', true)
      .gte('due_date', todayStr)
      .lte('due_date', today14Str),

    supabaseAdmin
      .from('audit_log')
      .select(`action, target_type, target_id, metadata, created_at, actor_member_id, actor_member:workspace_members!actor_member_id(display_name)`)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(10),

    pendingConfirmationsQuery,
    openDisputesQuery,
    recentMilestonesQuery,
  ]);

  let memberNamesMap = {};
  let containerNamesMap = {};

  if (targetsData && targetsData.length > 0) {
    const participantIds = [...new Set(targetsData.map(t => t.container_participant_id).filter(Boolean))];

    if (participantIds.length > 0) {
      const { data: participants } = await supabaseAdmin
        .from('container_participants')
        .select('id, workspace_member_id, workspace_members!inner(display_name)')
        .in('id', participantIds);

      const participantMap = {};
      (participants || []).forEach(p => {
        participantMap[p.id] = p.workspace_members?.display_name || null;
      });
      memberNamesMap = participantMap;
    }

    const containerIds = [...new Set(targetsData.map(t => t.container_id).filter(Boolean))];
    if (containerIds.length > 0) {
      const { data: containers } = await supabaseAdmin
        .from('containers')
        .select('id, name')
        .in('id', containerIds);
      containerNamesMap = (containers || []).reduce((acc, c) => {
        acc[c.id] = c.name;
        return acc;
      }, {});
    }
  }

  if (membersError)    logger.warn('Dashboard members query error',    { workspaceId, error: membersError.message });
  if (containersError) logger.warn('Dashboard containers query error', { workspaceId, error: containersError.message });
  if (poolsError)      logger.warn('Dashboard pools query error',      { workspaceId, error: poolsError.message });
  if (targetsError)    logger.warn('Dashboard targets query error',    { workspaceId, error: targetsError.message });
  if (activityError)   logger.warn('Dashboard activity query error',   { workspaceId, error: activityError.message });
  if (milestonesError) logger.warn('Dashboard milestones query error', { workspaceId, error: milestonesError.message });

  const active = (allMembers || []).filter((m) => m.is_active && !m.deleted_at);
  const summary = {
    member_count: active.length,
    admin_count:  active.filter((m) => m.role === 'admin').length,
    proxy_count:  active.filter((m) => m.is_proxy).length,
  };

  const activeEvents = (rawContainers || []).map((c) => {
    const confirmedEntries   = (c.ledger_entries || []).filter((le) => le.status === 'confirmed');
    const totalConfirmedBase = confirmedEntries.reduce((sum, le) => sum + parseFloat(le.base_amount || 0), 0);
    const participantCount   = (c.container_participants || []).length;
    const daysUntil          = c.event_date ? Math.ceil((new Date(c.event_date) - new Date()) / 86400000) : null;
    const progressPct        = c.budget_target && totalConfirmedBase ? Math.round((totalConfirmedBase / c.budget_target) * 100) : null;
    return {
      id: c.id,
      name: c.name,
      subtitle: c.subtitle,
      event_date: c.event_date,
      enable_money: c.enable_money,
      enable_tasks: c.enable_tasks,
      budget_target: c.budget_target,
      budget_currency: c.budget_currency,
      total_confirmed_base: totalConfirmedBase,
      participant_count: participantCount,
      days_until: daysUntil,
      progress_pct: progressPct
    };
  });

  const recurringPools = (pools || []).map((p) => {
    const currentCycle = (p.container_cycles || []).find((cc) => ['open', 'upcoming'].includes(cc.status)) || null;
    return { id: p.id, name: p.name, current_cycle: currentCycle };
  });

  const upcomingDeadlines = (targetsData || [])
    .filter((t) => t.container_id)
    .map((t) => {
      const participantId = t.container_participant_id;
      return {
        type:           'contribution',
        member_name:    memberNamesMap[participantId] || null,
        title:          `${t.target_amount} ${t.target_currency}`,
        container_name: containerNamesMap[t.container_id] || null,
        due_date:       t.due_date,
        days_until:     t.due_date ? Math.ceil((new Date(t.due_date) - new Date()) / 86400000) : null,
      };
    });

  const pendingConfirmations = isAdmin
    ? (pending || []).map((le) => ({
        ...le,
        contributor_name:   le.contributor?.display_name,
        recorded_by_name:   le.recorded_by_member?.display_name,
        contributor:        undefined,
        recorded_by_member: undefined,
      }))
    : [];

  const enrichedActivity = (activity || []).map((a) => ({
    ...a,
    actor_name:   a.actor_member?.display_name || 'System',
    description:  describeAuditAction(a.action, a.metadata),
    actor_member: undefined,
  }));

  // ── New: recent milestones, shaped ──
  const recentMilestonesShaped = (recentMilestones || []).map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    milestone_date: m.milestone_date,
    milestone_type: m.milestone_type,
    cover_photo: Array.isArray(m.photos) && m.photos.length ? m.photos[0] : null,
  }));

  return {
    workspace_summary:     summary,
    active_events:         activeEvents,
    recurring_pools:       recurringPools,
    upcoming_deadlines:    upcomingDeadlines,
    pending_confirmations: pendingConfirmations,
    recent_activity:       enrichedActivity,
    open_disputes_count:   isAdmin ? (openDisputesCount || 0) : null,
    recent_milestones:     recentMilestonesShaped,
  };
}

/**
 * Pending/in_progress/overdue task counts assigned to the caller, across
 * this workspace's containers, plus the single nearest-due task for a
 * "next up" pointer.
 */
async function getMyTasksSummary({ workspaceId, memberId }) {
  const { data: containers, error: cErr } = await supabaseAdmin
    .from('containers')
    .select('id, name')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (cErr) {
    logger.warn('Dashboard my-tasks containers query error', { workspaceId, error: cErr.message });
    return { pending_count: 0, in_progress_count: 0, overdue_count: 0, next_due: null };
  }

  const containerIds = (containers || []).map((c) => c.id);
  if (!containerIds.length) {
    return { pending_count: 0, in_progress_count: 0, overdue_count: 0, next_due: null };
  }

  const containerNameById = Object.fromEntries((containers || []).map((c) => [c.id, c.name]));

  const { data: tasks, error: tErr } = await supabaseAdmin
    .from('container_tasks')
    .select('id, title, status, due_date, container_id')
    .eq('assigned_to', memberId)
    .in('container_id', containerIds)
    .in('status', ['pending', 'in_progress', 'overdue'])
    .is('deleted_at', null)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (tErr) {
    logger.warn('Dashboard my-tasks query error', { workspaceId, memberId, error: tErr.message });
    return { pending_count: 0, in_progress_count: 0, overdue_count: 0, next_due: null };
  }

  const rows = tasks || [];
  const pendingCount    = rows.filter((t) => t.status === 'pending').length;
  const inProgressCount = rows.filter((t) => t.status === 'in_progress').length;
  const overdueCount    = rows.filter((t) => t.status === 'overdue').length;

  const nextTask = rows.find((t) => t.due_date) || null;

  return {
    pending_count:     pendingCount,
    in_progress_count: inProgressCount,
    overdue_count:     overdueCount,
    next_due: nextTask
      ? {
          id: nextTask.id,
          title: nextTask.title,
          due_date: nextTask.due_date,
          container_id: nextTask.container_id,
          container_name: containerNameById[nextTask.container_id] || null,
        }
      : null,
  };
}

/**
 * Engagement snapshot for admins: counts of quiet/inactive members,
 * delegating to computeEngagement().
 */
async function getEngagementSummary({ workspaceId }) {
  const { data: members, error } = await supabaseAdmin
    .from('workspace_members')
    .select('id, display_name, last_active_at')
    .eq('workspace_id', workspaceId)
    .eq('is_proxy', false)
    .is('deleted_at', null);

  if (error) {
    logger.warn('Dashboard engagement query error', { workspaceId, error: error.message });
    return { quiet_count: 0, inactive_count: 0, inactive_members: [] };
  }

  const computed = await computeEngagement(members || []);

  const quiet    = computed.filter((m) => m.engagement_level === 'quiet');
  const inactive = computed.filter((m) => m.engagement_level === 'inactive');

  return {
    quiet_count:      quiet.length,
    inactive_count:   inactive.length,
    inactive_members: inactive.slice(0, 5).map((m) => ({ member_id: m.member_id, display_name: m.display_name })),
  };
}

/**
 * Builds the full workspace dashboard payload: summary counts, active
 * events, recurring pools, upcoming deadlines, pending confirmations
 * (admin only), recent activity, and unread notification count, plus:
 * overdue summary, my-tasks summary, open disputes count, engagement summary.
 */
async function getDashboardData({ workspaceId, isAdmin, memberId }) {
  const [cached, unreadCount] = await Promise.all([
    getCachedDashboard(workspaceId, isAdmin),
    getUnreadNotificationCount(memberId),
  ]);

  const shared = cached || await buildSharedDashboardPayload({ workspaceId, isAdmin });

  if (!cached) {
    // Fire-and-forget — never block the response on the cache write.
    setCachedDashboard(workspaceId, isAdmin, shared);
  }

  // ── New: my-tasks summary (per-member, not cached) ──
  const myTasksSummary = await getMyTasksSummary({ workspaceId, memberId });

  // ── New: engagement summary (admin only) ──
  const engagementSummary = isAdmin
    ? await getEngagementSummary({ workspaceId })
    : null;

  return {
    ...shared,
    unread_notification_count: unreadCount,
    unread_activity_count:     shared.recent_activity.length,
    my_tasks_summary:          myTasksSummary,
    engagement_summary:        engagementSummary,
  };
}

/**
 * Computes, per member, total outstanding balance across all active
 * money-enabled containers where their current target is past due.
 */
async function getOverdueSummaryData({ workspaceId }) {
  const cached = await getCachedOverdueSummary(workspaceId);
  if (cached) return cached;

  const today = new Date().toISOString().split('T')[0];

  const { data: participants, error: pErr } = await supabaseAdmin
    .from('container_participants')
    .select(`
      workspace_member_id, container_id, money_enabled,
      containers!inner(name, status, workspace_id, enable_money),
      contributor_targets(target_amount, target_currency, due_date, is_current, cycle_id)
    `)
    .eq('containers.workspace_id', workspaceId)
    .eq('containers.status', 'active')
    .eq('containers.enable_money', true)
    .eq('money_enabled', true);

  if (pErr) throw new Error(pErr.message);

  const { data: ledger, error: lErr } = await supabaseAdmin
    .from('ledger_entries')
    .select('contributor_id, container_id, base_amount')
    .eq('workspace_id', workspaceId)
    .eq('status', 'confirmed');

  if (lErr) throw new Error(lErr.message);

  const paidMap = new Map();
  for (const le of (ledger || [])) {
    const key = `${le.contributor_id}:${le.container_id}`;
    paidMap.set(key, (paidMap.get(key) || 0) + parseFloat(le.base_amount || 0));
  }

  const overdueByMember = new Map();

  for (const p of (participants || [])) {
    const currentTarget = (p.contributor_targets || []).find((t) => t.is_current && t.cycle_id === null);
    if (!currentTarget || !currentTarget.due_date) continue;
    if (currentTarget.due_date >= today) continue;

    const paid        = paidMap.get(`${p.workspace_member_id}:${p.container_id}`) || 0;
    const outstanding = parseFloat(currentTarget.target_amount) - paid;
    if (outstanding <= 0) continue;

    if (!overdueByMember.has(p.workspace_member_id)) {
      overdueByMember.set(p.workspace_member_id, { member_id: p.workspace_member_id, total_outstanding: 0, containers: [] });
    }

    const entry = overdueByMember.get(p.workspace_member_id);
    entry.total_outstanding += outstanding;
    entry.containers.push({ container_id: p.container_id, container_name: p.containers?.name, outstanding, currency: currentTarget.target_currency, due_date: currentTarget.due_date });
  }

  const overdueIds    = [...overdueByMember.keys()];
  const displayNames  = {};

  if (overdueIds.length > 0) {
    const { data: members } = await supabaseAdmin
      .from('workspace_members').select('id, display_name').in('id', overdueIds);
    for (const m of (members || [])) displayNames[m.id] = m.display_name;
  }

  const overdue = [...overdueByMember.values()].map((entry) => ({
    ...entry,
    display_name: displayNames[entry.member_id] || null,
  }));

  const result = { overdue_count: overdue.length, overdue };

  // Fire-and-forget — never block the response on the cache write.
  setCachedOverdueSummary(workspaceId, result);

  return result;
}

module.exports = {
  getDashboardData,
  getOverdueSummaryData,
};