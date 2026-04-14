// src/controllers/workspace.controller.js
const { supabaseAdmin } = require('../config/supabase');
const { success }       = require('../utils/response');
const { NotFoundError } = require('../utils/errors');
const { createWorkspaceSchema, updateWorkspaceSchema, updateSettingsSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');

// ── List workspaces ────────────────────────────────────────────────

async function listWorkspaces(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('workspace_members')
      .select('role, id, display_name, workspaces!inner(*)')
      .eq('user_id', req.user.id)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('joined_at', { ascending: true });

    if (error) throw new Error(error.message);

    const workspaces = (data || []).map((m) => ({
      ...m.workspaces, role: m.role, member_id: m.id, display_name: m.display_name,
    }));

    success(res, { workspaces });
  } catch (err) { next(err); }
}

// ── Create workspace ───────────────────────────────────────────────

async function createWorkspace(req, res, next) {
  try {
    const data   = createWorkspaceSchema.parse(req.body);
    const userId = req.user.id;

    // Create workspace
    const { data: workspace, error: wsErr } = await supabaseAdmin
      .from('workspaces')
      .insert({ name: data.name, base_currency: data.base_currency, family_type: data.family_type, description: data.description || null, created_by: userId })
      .select()
      .single();

    if (wsErr) {
      console.log("Supabase error found", wsErr.message);
      throw new Error(wsErr.message);
    }

    // Get user display name
    const { data: user } = await supabaseAdmin.from('users').select('full_name').eq('id', userId).single();
    const displayName    = user?.full_name || 'Admin';

    // Create creator as admin member
    const { data: member, error: memErr } = await supabaseAdmin
      .from('workspace_members')
      .insert({ workspace_id: workspace.id, user_id: userId, role: 'admin', display_name: displayName, invite_status: 'accepted' })
      .select()
      .single();

    if (memErr) {
      console.log("Member creation error", memErr.message);
      throw new Error(memErr.message);
    }

    // Seed default settings
    await supabaseAdmin.from('workspace_settings').insert([
      { workspace_id: workspace.id, setting_key: 'notification_prefs', setting_value: { reminder_days_before: [3,1], overdue_notify_after_days: [3,7], weekly_digest_enabled: true } },
      { workspace_id: workspace.id, setting_key: 'reminder_templates', setting_value: { due_soon: 'Hi {name}, just a reminder about your contribution for {event_name}: {target_amount} {currency} due {due_date}.', overdue: 'Hi {name}, your contribution for {event_name} is now overdue.' } },
      { workspace_id: workspace.id, setting_key: 'invite_message',     setting_value: { template: 'Join our family on Kith: {invite_link}' } },
    ]);

    success(res, { workspace, member }, 201);
  } catch (err) {
    console.log("Error found", err.message);
    next(err);
  }
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

// ── Update workspace ───────────────────────────────────────────────

async function updateWorkspace(req, res, next) {
  try {
    const data          = updateWorkspaceSchema.parse(req.body);
    const { workspaceId } = req.params;

    const updates = {};
    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) updates[key] = val;
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

    await audit.log({ ...audit.fromReq(req), action: 'workspace.settings_changed', targetType: 'workspace', targetId: workspaceId, metadata: { fields: Object.keys(data) } });

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

    await audit.log({ ...audit.fromReq(req), action: 'workspace.deleted', targetType: 'workspace', targetId: workspaceId });

    success(res, { message: 'Workspace deleted.' });
  } catch (err) { next(err); }
}

// ── Dashboard ─────────────────────────────────────────────────────

// ── Dashboard ─────────────────────────────────────────────────────

async function getDashboard(req, res, next) {
  try {
    const { workspaceId } = req.params;
    console.log("========================================");
    console.log("📊 Dashboard requested for workspace:", workspaceId);
    console.log("👤 User member:", { id: req.member?.id, role: req.member?.role });
    
    // Validate workspaceId
    if (!workspaceId) {
      console.error("❌ No workspaceId provided");
      throw new Error("Workspace ID is required");
    }
    
    const isAdmin = req.member?.role === 'admin';
    const memberId = req.member?.id;
    
    console.log(`🔐 Is admin: ${isAdmin}, Member ID: ${memberId}`);

    // 1. Member counts
    console.log("📊 Fetching member counts...");
    const { data: allMembers, error: membersError } = await supabaseAdmin
      .from('workspace_members')
      .select('role, is_active, is_proxy, deleted_at')
      .eq('workspace_id', workspaceId);

    if (membersError) {
      console.error("❌ Members query error:", membersError);
      throw new Error(`Members query failed: ${membersError.message}`);
    }
    
    const active = (allMembers || []).filter((m) => m.is_active && !m.deleted_at);
    const summary = {
      member_count: active.length,
      admin_count: active.filter((m) => m.role === 'admin').length,
      proxy_count: active.filter((m) => m.is_proxy).length,
    };
    console.log(`✅ Member counts: ${summary.member_count} total, ${summary.admin_count} admins, ${summary.proxy_count} proxies`);

    // 2. Active event containers
    console.log("📅 Fetching active events...");
    const { data: rawContainers, error: containersError } = await supabaseAdmin
      .from('containers')
      .select('id, name, subtitle, event_date, enable_money, enable_tasks, budget_target, budget_currency, container_participants(id), ledger_entries(base_amount, status)')
      .eq('workspace_id', workspaceId)
      .eq('container_type', 'event')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('event_date', { ascending: true, nullsFirst: false });

    if (containersError) {
      console.error("❌ Containers query error:", containersError);
      // Non-fatal - continue with empty array
    }

    const activeEvents = (rawContainers || []).map((c) => {
      const confirmedEntries = (c.ledger_entries || []).filter((le) => le.status === 'confirmed');
      const totalConfirmedBase = confirmedEntries.reduce((sum, le) => sum + parseFloat(le.base_amount || 0), 0);
      const participantCount = (c.container_participants || []).length;
      const daysUntil = c.event_date ? Math.ceil((new Date(c.event_date) - new Date()) / 86400000) : null;
      const progressPct = c.budget_target && totalConfirmedBase ? Math.round((totalConfirmedBase / c.budget_target) * 100) : null;
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
    console.log(`✅ Found ${activeEvents.length} active events`);

    // 3. Recurring pools
    console.log("🔄 Fetching recurring pools...");
    const { data: pools, error: poolsError } = await supabaseAdmin
      .from('containers')
      .select('id, name, container_cycles(id, cycle_start, cycle_end, status, total_expected, total_collected)')
      .eq('workspace_id', workspaceId)
      .eq('container_type', 'recurring')
      .eq('status', 'active')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (poolsError) {
      console.error("❌ Pools query error:", poolsError);
    }

    const recurringPools = (pools || []).map((p) => {
      const currentCycle = (p.container_cycles || []).find((cc) => ['open', 'upcoming'].includes(cc.status)) || null;
      return { id: p.id, name: p.name, current_cycle: currentCycle };
    });
    console.log(`✅ Found ${recurringPools.length} recurring pools`);

    // 4. Upcoming deadlines (next 14 days)
    console.log("⏰ Fetching upcoming deadlines...");
    const today = new Date();
    const today14 = new Date();
    today14.setDate(today14.getDate() + 14);
    const todayStr = today.toISOString().split('T')[0];
    const today14Str = today14.toISOString().split('T')[0];
    
    console.log(`📅 Date range: ${todayStr} to ${today14Str}`);

    const { data: targets, error: targetsError } = await supabaseAdmin
      .from('contributor_targets')
      .select(`
        target_amount, target_currency, due_date,
        container_participant:container_participants!container_participant_id(
          workspace_member_id,
          workspace_members!inner(display_name)
        ),
        container:containers!container_id(name, workspace_id)
      `)
      .eq('is_current', true)
      .gte('due_date', todayStr)
      .lte('due_date', today14Str);

    if (targetsError) {
      console.error("❌ Targets query error:", targetsError);
    }

    const upcomingDeadlines = (targets || [])
      .filter((t) => t.container?.workspace_id === workspaceId)
      .map((t) => ({
        type: 'contribution',
        member_name: t.container_participant?.workspace_members?.display_name,
        title: `${t.target_amount} ${t.target_currency}`,
        container_name: t.container?.name,
        due_date: t.due_date,
        days_until: Math.ceil((new Date(t.due_date) - new Date()) / 86400000),
      }));
    console.log(`✅ Found ${upcomingDeadlines.length} upcoming deadlines`);

    // 5. Pending confirmations (admin only)
    let pendingConfirmations = [];
    if (isAdmin) {
      console.log("👑 Admin - fetching pending confirmations...");
      const { data: pending, error: pendingError } = await supabaseAdmin
        .from('ledger_entries')
        .select('*, contributor:workspace_members!contributor_id(display_name), recorded_by_member:workspace_members!recorded_by(display_name)')
        .eq('workspace_id', workspaceId)
        .in('status', ['pending', 'proof_uploaded'])
        .order('recorded_at', { ascending: true })
        .limit(10);

      if (pendingError) {
        console.error("❌ Pending confirmations error:", pendingError);
      } else {
        pendingConfirmations = (pending || []).map((le) => ({ 
          ...le, 
          contributor_name: le.contributor?.display_name, 
          recorded_by_name: le.recorded_by_member?.display_name 
        }));
        console.log(`✅ Found ${pendingConfirmations.length} pending confirmations`);
      }
    }

    // 6. Recent activity (audit log)
    console.log("📝 Fetching recent activity...");
    const { data: activity, error: activityError } = await supabaseAdmin
      .from('audit_log')
      .select('action, target_type, target_id, metadata, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (activityError) {
      console.error("❌ Activity query error:", activityError);
    }
    console.log(`✅ Found ${activity?.length || 0} recent activities`);

    // 7. Unread notifications
    console.log("🔔 Fetching unread notifications...");
    const { count: unreadCount, error: notifError } = await supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('recipient_id', memberId)
      .eq('is_read', false);

    if (notifError) {
      console.error("❌ Notifications query error:", notifError);
    }
    console.log(`✅ ${unreadCount || 0} unread notifications`);

    // Prepare final dashboard data
    const dashboardData = {
      workspace_summary: summary,
      active_events: activeEvents,
      recurring_pools: recurringPools,
      upcoming_deadlines: upcomingDeadlines,
      pending_confirmations: pendingConfirmations,
      recent_activity: activity || [],
      unread_notification_count: unreadCount || 0,
      unread_activity_count: (activity || []).length,
    };
    
    console.log("✅ Dashboard data prepared successfully");
    console.log("📦 Data keys:", Object.keys(dashboardData));
    console.log("========================================");
    
    success(res, dashboardData);
  } catch (err) { 
    console.error("💥 Dashboard error:", err);
    console.error("Stack trace:", err.stack);
    next(err); 
  }
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

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        await supabaseAdmin
          .from('workspace_settings')
          .upsert(
            { workspace_id: workspaceId, setting_key: key, setting_value: value, updated_by: req.member.id, updated_at: new Date().toISOString() },
            { onConflict: 'workspace_id,setting_key' }
          );
      }
    }

    await audit.log({ ...audit.fromReq(req), action: 'workspace.settings_changed', targetType: 'workspace', targetId: workspaceId, metadata: { keys: Object.keys(data) } });

    const { data: rows, error } = await supabaseAdmin
      .from('workspace_settings').select('setting_key, setting_value').eq('workspace_id', workspaceId);

    if (error) throw new Error(error.message);

    const settings = {};
    for (const row of (rows || [])) settings[row.setting_key] = row.setting_value;

    success(res, { settings });
  } catch (err) { next(err); }
}

module.exports = { listWorkspaces, createWorkspace, getWorkspace, updateWorkspace, deleteWorkspace, getDashboard, getSettings, updateSettings };
