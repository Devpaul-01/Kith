// src/controllers/workspace.controller.js
const { supabaseAdmin } = require('../config/supabase');
const { success, paginate } = require('../utils/response');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { uploadFileSchema }  = require('../validators/ledger.validator');
const { generateUploadUrl } = require('../services/storage.service');
const {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  updateSettingsSchema,
  announceSchema,
} = require('../validators/workspace.validator');
const audit        = require('../services/audit.service');
const notification = require('../services/notification.service');
const logger        = require('../utils/logger');
const { AUDIT_ACTIONS, describeAuditAction } = require('../constants/audit-actions');
const { getPagination } = require('../utils/pagination');

// ── List workspaces ────────────────────────────────────────────────
//
// Note: `plan` is intentionally NOT selected/shaped here — it isn't a
// column on the workspaces table.

async function listWorkspaces(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('workspace_members')
      .select(`
        id, role, display_name, workspace_id,
        workspaces ( id, name, base_currency, avatar_url, visibility )
      `)
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('joined_at', { ascending: true });

    if (error) throw new Error(error.message);

    const memberships = (data || []).map((m) => ({
      member_id:      m.id,
      role:           m.role,
      display_name:   m.display_name,
      workspace_id:   m.workspace_id,
      workspace_name: m.workspaces?.name         ?? null,
      base_currency:  m.workspaces?.base_currency ?? null,
      avatar_url:     m.workspaces?.avatar_url    ?? null,
      visibility:     m.workspaces?.visibility    ?? null,
    }));

    success(res, { memberships });
  } catch (err) { next(err); }
}

async function createWorkspace(req, res, next) {
  try {
    const data   = createWorkspaceSchema.parse(req.body);
    const userId = req.user.id;

    const { data: result, error } = await supabaseAdmin.rpc('create_workspace_with_admin', {
      p_name:          data.name,
      p_base_currency: data.base_currency,
      p_family_type:   data.family_type,
      p_description:   data.description || null,
      p_user_id:       userId,
    });

    if (error) throw new Error(error.message);

    success(res, result, 201);
  } catch (err) { next(err); }
}

// ── Get workspace ──────────────────────────────────────────────────

async function getWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('workspaces').select('*').eq('id', workspaceId).is('deleted_at', null).maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Workspace not found');

    success(res, { workspace: data, current_member: req.member });
  } catch (err) { next(err); }
}

// ── Avatar upload URL ──────────────────────────────────────────────

async function getAvatarUploadUrl(req, res, next) {
  try {
    const data            = uploadFileSchema.parse(req.body);
    const { workspaceId } = req.params;
    const result = await generateUploadUrl({
      workspaceId,
      folder:      'workspace-avatars',
      filename:    data.filename,
      contentType: data.content_type,
      fileSize:    data.file_size,
      fileType:    'workspace_avatar',
    });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Update workspace ───────────────────────────────────────────────
//
// Issue M7 fix: this was the only update handler in the codebase with no
// explicit field whitelist — it spread the entire validated Zod object
// directly into the DB update (`for (const [key, val] of
// Object.entries(data))`), trusting the schema as the sole boundary. Every
// other update handler (updateMember, updateTask, updateContainer,
// updateParticipant) uses an explicit allowedFields array as defense in
// depth against the schema ever admitting a field that shouldn't be
// directly writable. Brought in line with that pattern here, on arguably
// the most sensitive resource (workspace-level settings, including
// `visibility`).

async function updateWorkspace(req, res, next) {
  try {
    const data            = updateWorkspaceSchema.parse(req.body);
    const { workspaceId } = req.params;

    const allowedFields = [
      'name', 'base_currency', 'family_type', 'description', 'avatar_url', 'visibility',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (!Object.keys(updates).length) {
      const { data: ws } = await supabaseAdmin.from('workspaces').select('*').eq('id', workspaceId).single();
      return success(res, { workspace: ws });
    }

    updates.updated_at = new Date().toISOString();

    const { data: workspace, error } = await supabaseAdmin
      .from('workspaces').update(updates).eq('id', workspaceId).is('deleted_at', null).select().maybeSingle();

    if (error) throw new Error(error.message);
    if (!workspace) throw new NotFoundError('Workspace not found');

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, targetType: 'workspace', targetId: workspaceId, metadata: { fields: Object.keys(updates).filter((k) => k !== 'updated_at') } });

    success(res, { workspace });
  } catch (err) { next(err); }
}

// ── Delete workspace ───────────────────────────────────────────────

async function deleteWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const now             = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('workspaces').update({ deleted_at: now, updated_at: now }).eq('id', workspaceId).is('deleted_at', null).select('id').maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Workspace not found');

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.WORKSPACE_DELETED, targetType: 'workspace', targetId: workspaceId });

    success(res, { message: 'Workspace deleted.' });
  } catch (err) { next(err); }
}

// ── Dashboard ─────────────────────────────────────────────────────
//
// Issue M3 fix: the hand-synced `actions` lookup table previously lived
// here and had to be kept in lockstep by hand with every `action:` string
// literal scattered across the other controllers. Replaced with
// describeAuditAction() from constants/audit-actions.js, which shares the
// exact same AUDIT_ACTIONS values those controllers now import — a typo
// or a forgotten update in either place is no longer possible since
// there's only one place.

async function getDashboard(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const isAdmin         = req.member?.role === 'admin';
    const memberId        = req.member?.id;

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

    // ── FIX: Split contributor_targets into separate queries ──────────────
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

      // ── FIX: Simple query without the problematic embed ────────────────
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

    // ── FIX: Manually resolve member names for targets ────────────────────
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

    // ── Log non-critical errors (optional) ──────────────────────────────
    if (membersError)    logger.warn('Dashboard members query error',    { workspaceId, error: membersError.message });
    if (containersError) logger.warn('Dashboard containers query error', { workspaceId, error: containersError.message });
    if (poolsError)      logger.warn('Dashboard pools query error',      { workspaceId, error: poolsError.message });
    if (targetsError)    logger.warn('Dashboard targets query error',    { workspaceId, error: targetsError.message });
    if (activityError)   logger.warn('Dashboard activity query error',   { workspaceId, error: activityError.message });
    if (notifError)      logger.warn('Dashboard notifications error',    { workspaceId, error: notifError.message });

    // ── Build response ────────────────────────────────────────────────────
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

    // ── FIX: Build deadlines with resolved names ──────────────────────────
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

    success(res, {
      workspace_summary:         summary,
      active_events:             activeEvents,
      recurring_pools:           recurringPools,
      upcoming_deadlines:        upcomingDeadlines,
      pending_confirmations:     pendingConfirmations,
      recent_activity:           enrichedActivity,
      unread_notification_count: unreadCount || 0,
      unread_activity_count:     enrichedActivity.length,
    });
  } catch (err) { next(err); }
}

// ── Settings ───────────────────────────────────────────────────────

async function getSettings(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { data, error } = await supabaseAdmin
      .from('workspace_settings').select('setting_key, setting_value').eq('workspace_id', workspaceId);

    if (error) throw new Error(error.message);

    const settings = {};
    for (const row of (data || [])) settings[row.setting_key] = row.setting_value;

    success(res, { settings });
  } catch (err) { next(err); }
}

async function updateSettings(req, res, next) {
  try {
    const data            = updateSettingsSchema.parse(req.body);
    const { workspaceId } = req.params;

    const rows = Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({
        workspace_id:  workspaceId,
        setting_key:   key,
        setting_value: value,
        updated_by:    req.member.id,
        updated_at:    new Date().toISOString(),
      }));

    if (rows.length) {
      const { error } = await supabaseAdmin
        .from('workspace_settings')
        .upsert(rows, { onConflict: 'workspace_id,setting_key' });
      if (error) throw new Error(error.message);
    }

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, targetType: 'workspace', targetId: workspaceId, metadata: { keys: Object.keys(data) } });

    const { data: allRows, error: fetchErr } = await supabaseAdmin
      .from('workspace_settings').select('setting_key, setting_value').eq('workspace_id', workspaceId);

    if (fetchErr) throw new Error(fetchErr.message);

    const settings = {};
    for (const row of (allRows || [])) settings[row.setting_key] = row.setting_value;

    success(res, { settings });
  } catch (err) { next(err); }
}

// ── Admin Announcement ─────────────────────────────────────────────

async function announceToWorkspace(req, res, next) {
  try {
    const { workspaceId }              = req.params;
    const { title, body, target_role } = announceSchema.parse(req.body);

    let query = supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('is_active', true)
      .is('deleted_at', null);

    const validRoles = ['admin', 'member'];
    if (target_role) {
      if (!validRoles.includes(target_role)) {
        throw new ValidationError(`target_role must be one of: ${validRoles.join(', ')}`, 'target_role');
      }
      query = query.eq('role', target_role);
    }

    const { data: members, error } = await query;
    if (error) throw new Error(error.message);

    const recipientIds = (members || []).map((m) => m.id);
    if (!recipientIds.length) {
      return success(res, { sent_count: 0 });
    }

    await notification.send({
      type:          'admin_announcement',
      workspaceId,
      recipientIds,
      referenceType: 'workspace',
      referenceId:   workspaceId,
      variables:     { title, body },
    });

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.WORKSPACE_ANNOUNCEMENT_SENT, targetType: 'workspace', targetId: workspaceId, metadata: { title, recipient_count: recipientIds.length, target_role: target_role || 'all' } });

    success(res, { sent_count: recipientIds.length });
  } catch (err) { next(err); }
}

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

async function getOverdueSummary(req, res, next) {
  try {
    const { workspaceId } = req.params;
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

    success(res, { overdue_count: overdue.length, overdue });
  } catch (err) { next(err); }
}

// ── Search ─────────────────────────────────────────────────────────
//
// Cross-entity search across active members (by display_name) and
// containers (by name) in
// parallel. Results are typed so the client can render them differently.
// Scoped to the current workspace; requires active membership (via requireMembership).
//
// Issue L7 fix: `%` and `_` are ILIKE wildcard metacharacters. A user
// typing either into the search box previously got non-obvious matching
// behavior (broader or narrower than intended) because they were
// interpolated into the pattern unescaped. Now escaped before building
// the `%...%` pattern.

function escapeIlike(str) {
  return str.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

async function searchWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const query           = (req.query.q || '').trim();
    const limit           = Math.min(20, parseInt(req.query.limit) || 10);

    if (!query || query.length < 2) {
      return success(res, { results: [] });
    }

    const pattern = `%${escapeIlike(query)}%`;

    const [{ data: members }, { data: containers }] = await Promise.all([
      supabaseAdmin
        .from('workspace_members')
        .select('id, display_name, role, is_proxy')
        .eq('workspace_id', workspaceId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .ilike('display_name', pattern)
        .limit(limit),

      supabaseAdmin
        .from('containers')
        .select('id, name, container_type, status')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .ilike('name', pattern)
        .limit(limit),
    ]);

    const results = [
      ...(members    || []).map((m) => ({ type: 'member',    id: m.id, display_name: m.display_name, role: m.role, is_proxy: m.is_proxy })),
      ...(containers || []).map((c) => ({ type: 'container', id: c.id, name: c.name, container_type: c.container_type, status: c.status })),
    ];

    success(res, { results, query });
  } catch (err) { next(err); }
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getAvatarUploadUrl,
  getDashboard,
  getSettings,
  updateSettings,
  announceToWorkspace,
  getAuditLog,
  exportAuditLog,
  getOverdueSummary,
  searchWorkspace,
};
