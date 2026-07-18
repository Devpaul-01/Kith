// src/controllers/workspace.controller.js
//
// Fixes audit finding 3.6: this file previously owned CRUD, avatar
// upload, the full dashboard aggregation, settings, admin announcements,
// audit log list+export, overdue-summary computation, AND cross-entity
// search — six distinct responsibilities in one ~700-line file. Split
// into workspace.controller.js (CRUD + settings + announce + avatar),
// dashboard.controller.js (getDashboard, getOverdueSummary),
// audit.controller.js (getAuditLog, exportAuditLog), and
// search.controller.js (searchWorkspace). Route wiring updated in
// routes/workspace.routes.js accordingly — no path or contract changes.
const { supabaseAdmin } = require('../config/supabase');
const { success } = require('../utils/response');
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
const { AUDIT_ACTIONS } = require('../constants/audit-actions');

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

module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getAvatarUploadUrl,
  getSettings,
  updateSettings,
  announceToWorkspace,
};
