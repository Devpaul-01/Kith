// src/services/workspace.service.js
//
// Extracted from workspace.controller.js as part of the service-layer
// refactor. All DB/RPC calls, field whitelisting, audit logging, and
// notification orchestration now live here. Behavior is unchanged
// (including issue M7's explicit allowedFields whitelist on
// updateWorkspace).

const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { generateUploadUrl } = require('./storage.service');
const audit        = require('./audit_log.service');
const notification = require('./notification.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');

async function listWorkspacesForUser({ userId }) {
  const { data, error } = await supabaseAdmin
    .from('workspace_members')
    .select(`
      id, role, display_name, workspace_id,
      workspaces ( id, name, base_currency, avatar_url, visibility )
    `)
    .eq('user_id', userId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('joined_at', { ascending: true });

  if (error) throw new Error(error.message);

  return (data || []).map((m) => ({
    member_id:      m.id,
    role:           m.role,
    display_name:   m.display_name,
    workspace_id:   m.workspace_id,
    workspace_name: m.workspaces?.name         ?? null,
    base_currency:  m.workspaces?.base_currency ?? null,
    avatar_url:     m.workspaces?.avatar_url    ?? null,
    visibility:     m.workspaces?.visibility    ?? null,
  }));
}

async function createWorkspace({ userId, name, base_currency, family_type, description }) {
  const { data: result, error } = await supabaseAdmin.rpc('create_workspace_with_admin', {
    p_name:          name,
    p_base_currency: base_currency,
    p_family_type:   family_type,
    p_description:   description || null,
    p_user_id:       userId,
  });

  if (error) throw new Error(error.message);
  return result;
}

async function getWorkspaceById({ workspaceId }) {
  const { data, error } = await supabaseAdmin
    .from('workspaces').select('*').eq('id', workspaceId).is('deleted_at', null).maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Workspace not found');

  return data;
}

async function generateWorkspaceAvatarUploadUrl({ workspaceId, filename, contentType, fileSize }) {
  return generateUploadUrl({
    workspaceId,
    folder:      'workspace-avatars',
    filename,
    contentType,
    fileSize,
    fileType:    'workspace_avatar',
  });
}

// Issue M7 fix: explicit field whitelist as defense in depth (see original
// comment in workspace.controller.js history) — preserved here verbatim.
const WORKSPACE_UPDATE_ALLOWED_FIELDS = [
  'name', 'base_currency', 'family_type', 'description', 'avatar_url', 'visibility',
];

async function updateWorkspace({ workspaceId, data, actorCtx }) {
  const updates = {};
  for (const field of WORKSPACE_UPDATE_ALLOWED_FIELDS) {
    if (data[field] !== undefined) updates[field] = data[field];
  }

  if (!Object.keys(updates).length) {
    const { data: ws } = await supabaseAdmin.from('workspaces').select('*').eq('id', workspaceId).single();
    return ws;
  }

  updates.updated_at = new Date().toISOString();

  const { data: workspace, error } = await supabaseAdmin
    .from('workspaces').update(updates).eq('id', workspaceId).is('deleted_at', null).select().maybeSingle();

  if (error) throw new Error(error.message);
  if (!workspace) throw new NotFoundError('Workspace not found');

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, targetType: 'workspace', targetId: workspaceId, metadata: { fields: Object.keys(updates).filter((k) => k !== 'updated_at') } });

  return workspace;
}

async function deleteWorkspace({ workspaceId, actorCtx }) {
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('workspaces').update({ deleted_at: now, updated_at: now }).eq('id', workspaceId).is('deleted_at', null).select('id').maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Workspace not found');

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.WORKSPACE_DELETED, targetType: 'workspace', targetId: workspaceId });
}

async function getSettings({ workspaceId }) {
  const { data, error } = await supabaseAdmin
    .from('workspace_settings').select('setting_key, setting_value').eq('workspace_id', workspaceId);

  if (error) throw new Error(error.message);

  const settings = {};
  for (const row of (data || [])) settings[row.setting_key] = row.setting_value;
  return settings;
}

async function updateSettings({ workspaceId, data, actorMemberId, actorCtx }) {
  const rows = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      workspace_id:  workspaceId,
      setting_key:   key,
      setting_value: value,
      updated_by:    actorMemberId,
      updated_at:    new Date().toISOString(),
    }));

  if (rows.length) {
    const { error } = await supabaseAdmin
      .from('workspace_settings')
      .upsert(rows, { onConflict: 'workspace_id,setting_key' });
    if (error) throw new Error(error.message);
  }

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.WORKSPACE_SETTINGS_CHANGED, targetType: 'workspace', targetId: workspaceId, metadata: { keys: Object.keys(data) } });

  return getSettings({ workspaceId });
}

const VALID_ANNOUNCE_ROLES = ['admin', 'member'];

async function announceToWorkspace({ workspaceId, title, body, target_role, actorCtx }) {
  let query = supabaseAdmin
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .is('deleted_at', null);

  if (target_role) {
    if (!VALID_ANNOUNCE_ROLES.includes(target_role)) {
      throw new ValidationError(`target_role must be one of: ${VALID_ANNOUNCE_ROLES.join(', ')}`, 'target_role');
    }
    query = query.eq('role', target_role);
  }

  const { data: members, error } = await query;
  if (error) throw new Error(error.message);

  const recipientIds = (members || []).map((m) => m.id);
  if (!recipientIds.length) {
    return { sent_count: 0 };
  }

  await notification.send({
    type:          'admin_announcement',
    workspaceId,
    recipientIds,
    referenceType: 'workspace',
    referenceId:   workspaceId,
    variables:     { title, body },
  });

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.WORKSPACE_ANNOUNCEMENT_SENT, targetType: 'workspace', targetId: workspaceId, metadata: { title, recipient_count: recipientIds.length, target_role: target_role || 'all' } });

  return { sent_count: recipientIds.length };
}

module.exports = {
  listWorkspacesForUser,
  createWorkspace,
  getWorkspaceById,
  generateWorkspaceAvatarUploadUrl,
  updateWorkspace,
  deleteWorkspace,
  getSettings,
  updateSettings,
  announceToWorkspace,
};
