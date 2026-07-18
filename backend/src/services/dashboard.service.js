// src/services/dashboard.service.js
//
// Extracted from dashboard.controller.js as part of the service-layer
// refactor. All aggregation/shaping logic (previously inline in the
// route handlers) now lives here; the controller only parses req,
// calls these functions, and calls success().

const { supabaseAdmin } = require('../config/supabase');
const logger = require('../utils/logger');
const { describeAuditAction } = require('../constants/audit-actions');

/**
 * Builds the full workspace dashboard payload: summary counts, active
 * events, recurring pools, upcoming deadlines, pending confirmations
 * (admin only), recent activity, and unread notification count.
 */
async function getDashboardData({ workspaceId, isAdmin, memberId }) {
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

  const [
    { data: allMembers,    error: membersError },
    { data: rawContainers, error: containersError },
    { data: pools,         error: poolsError },
    { data: targetsData,   error: targetsError },
    { data: activity,      error: activityError },
    { count: unreadCount,  error: notifError },
    { data: pending },
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

    supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', memberId)
      .eq('is_read', false),

    pendingConfirmationsQuery,
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
  if (notifError)      logger.warn('Dashboard notifications error',    { workspaceId, error: notifError.message });

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

  return {
    workspace_summary:         summary,
    active_events:             activeEvents,
    recurring_pools:           recurringPools,
    upcoming_deadlines:        upcomingDeadlines,
    pending_confirmations:     pendingConfirmations,
    recent_activity:           enrichedActivity,
    unread_notification_count: unreadCount || 0,
    unread_activity_count:     enrichedActivity.length,
  };
}

/**
 * Computes, per member, total outstanding balance across all active
 * money-enabled containers where their current target is past due.
 */
async function getOverdueSummaryData({ workspaceId }) {
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

  return { overdue_count: overdue.length, overdue };
}

module.exports = {
  getDashboardData,
  getOverdueSummaryData,
};
