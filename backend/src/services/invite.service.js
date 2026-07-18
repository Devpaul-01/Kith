// src/services/invite.service.js
//
// Extracted from invite.controller.js as part of the service-layer
// refactor. Preserves the atomic-claim pattern for acceptInvite (issue
// C4) and the uniform-200-response-shape pattern for previewInvite
// (issue L3) exactly as documented in the original controller.

const { supabaseAdmin }  = require('../config/supabase');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
const { generateToken }  = require('../utils/crypto');
const notification       = require('./notification.service');
const audit              = require('./audit.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');

async function createInvite({ workspaceId, actorMemberId, actorCtx }) {
  const token     = generateToken(24);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('invite_links')
    .insert({ workspace_id: workspaceId, token, created_by: actorMemberId, expires_at: expiresAt })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.MEMBER_INVITED, targetType: 'invite_link', targetId: data.id });

  return { token, invite_url: `${process.env.FRONTEND_URL}/invite/${token}`, expires_at: expiresAt };
}

// Issue L3 fix (documentation only, no behavior change): this
// intentionally returns { is_valid: false, error } for every failure case
// (not found / expired / used) rather than distinct 404/410 — deliberate,
// to avoid invite-token enumeration on this public, unauthenticated
// endpoint. See original controller history for full rationale.
async function previewInvite({ token }) {
  const { data: invite, error } = await supabaseAdmin
    .from('invite_links')
    .select('*, workspaces!inner(id, name), created_by_member:workspace_members!created_by(display_name)')
    .eq('token', token)
    .maybeSingle();

  if (error || !invite) return { is_valid: false, error: 'Invite not found' };
  if (new Date(invite.expires_at) < new Date()) return { is_valid: false, error: 'This invite link has expired' };
  if (invite.used_at)                           return { is_valid: false, error: 'This invite link has already been used' };

  const { data: containers } = await supabaseAdmin
    .from('containers')
    .select('id, name, container_type, enable_money, budget_target, budget_currency, ledger_entries(base_amount, status)')
    .eq('workspace_id', invite.workspaces.id)
    .eq('status', 'active')
    .is('deleted_at', null)
    .limit(3);

  const containerPreview = (containers || []).map((c) => ({
    id: c.id, name: c.name, container_type: c.container_type, enable_money: c.enable_money,
    budget_target: c.budget_target, budget_currency: c.budget_currency,
    total_confirmed_base: (c.ledger_entries || []).filter((le) => le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0),
  }));

  return {
    is_valid: true,
    workspace_name:            invite.workspaces.name,
    invited_by_name:           invite.created_by_member?.display_name,
    active_containers_preview: containerPreview,
  };
}

// Issue C4 fix: invite is claimed via a single atomic conditional UPDATE
// (`WHERE used_at IS NULL`) instead of check-then-act, closing the
// double-accept race. See original controller history for full rationale.
async function acceptInvite({ token, userId, actorCtx }) {
  const { data: invite, error: invErr } = await supabaseAdmin
    .from('invite_links')
    .select('*, workspaces!inner(*)')
    .eq('token', token)
    .maybeSingle();

  if (invErr) throw new Error(invErr.message);
  if (!invite) throw new NotFoundError('Invite not found');
  if (new Date(invite.expires_at) < new Date()) throw new BusinessRuleError('This invite has expired');
  if (invite.used_at) throw new BusinessRuleError('This invite has already been used');

  const { data: existingMember } = await supabaseAdmin
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', invite.workspace_id)
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle();

  if (existingMember) throw new ConflictError('You are already a member of this workspace');

  const { data: claimedInvite, error: claimErr } = await supabaseAdmin
    .from('invite_links')
    .update({ used_at: new Date().toISOString(), used_by_user_id: userId })
    .eq('id', invite.id)
    .is('used_at', null)
    .select()
    .maybeSingle();

  if (claimErr) throw new Error(claimErr.message);
  if (!claimedInvite) {
    throw new BusinessRuleError('This invite has already been used');
  }

  const { data: user } = await supabaseAdmin.from('users').select('full_name').eq('id', userId).single();
  const displayName    = user?.full_name || 'New Member';

  const { data: member, error: memErr } = await supabaseAdmin
    .from('workspace_members')
    .insert({ workspace_id: invite.workspace_id, user_id: userId, role: 'member', display_name: displayName, invite_status: 'accepted', invited_at: new Date().toISOString(), joined_at: new Date().toISOString() })
    .select()
    .single();

  if (memErr) throw new Error(memErr.message);

  const workspace = invite.workspaces;

  const { data: admins } = await supabaseAdmin
    .from('workspace_members').select('id').eq('workspace_id', workspace.id).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);

  await notification.send({ type: 'invite_accepted', workspaceId: workspace.id, recipientIds: (admins || []).map((a) => a.id), variables: { actor: member.display_name, workspace: workspace.name } });

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.MEMBER_ACCEPTED, targetType: 'workspace_member', targetId: member.id });

  return { workspace, member };
}

async function listInvites({ workspaceId }) {
  const { data, error } = await supabaseAdmin
    .from('invite_links')
    .select('*, created_by_member:workspace_members!created_by(display_name)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data || []).map((i) => ({ ...i, created_by_name: i.created_by_member?.display_name, created_by_member: undefined }));
}

async function revokeInvite({ workspaceId, inviteId }) {
  const { data, error } = await supabaseAdmin
    .from('invite_links').delete().eq('id', inviteId).eq('workspace_id', workspaceId).select('id').maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Invite not found');
}

module.exports = { createInvite, previewInvite, acceptInvite, listInvites, revokeInvite };
