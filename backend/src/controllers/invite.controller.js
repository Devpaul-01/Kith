// src/controllers/invite.controller.js
const { supabaseAdmin }  = require('../config/supabase');
const { success }        = require('../utils/response');
const { NotFoundError, ConflictError, BusinessRuleError } = require('../utils/errors');
const { generateToken }  = require('../utils/crypto');
const notification       = require('../services/notification.service');
const audit              = require('../services/audit.service');

async function createInvite(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const token           = generateToken(24);
    const expiresAt       = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('invite_links')
      .insert({ workspace_id: workspaceId, token, created_by: req.member.id, expires_at: expiresAt })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await audit.log({ ...audit.fromReq(req), action: 'member.invited', targetType: 'invite_link', targetId: data.id });

    success(res, { token, invite_url: `${process.env.FRONTEND_URL}/invite/${token}`, expires_at: expiresAt }, 201);
  } catch (err) { next(err); }
}

async function previewInvite(req, res, next) {
  try {
    const { token } = req.params;

    const { data: invite, error } = await supabaseAdmin
      .from('invite_links')
      .select('*, workspaces!inner(id, name), created_by_member:workspace_members!created_by(display_name)')
      .eq('token', token)
      .maybeSingle();

    if (error || !invite) return success(res, { is_valid: false, error: 'Invite not found' });
    if (new Date(invite.expires_at) < new Date()) return success(res, { is_valid: false, error: 'This invite link has expired' });
    if (invite.used_at)                           return success(res, { is_valid: false, error: 'This invite link has already been used' });

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

    success(res, {
      is_valid: true,
      workspace_name:            invite.workspaces.name,
      invited_by_name:           invite.created_by_member?.display_name,
      active_containers_preview: containerPreview,
    });
  } catch (err) { next(err); }
}

// ── Accept invite ──────────────────────────────────────────────────
//
// Issue C4 fix: this previously used a check-then-act pattern — read
// invite.used_at, verify it's null, and only much later write used_at.
// Two concurrent requests with the same token (e.g. a double-tap on
// mobile, or a retried request after a slow/timed-out response) could
// both read used_at: null, both pass the check, both create a
// workspace_members row, and only then race to set used_at — the loser
// silently overwriting the winner's used_by_user_id.
//
// Fixed by claiming the invite with a single atomic conditional UPDATE
// (`WHERE used_at IS NULL`) instead. Supabase/Postgrest performs this as
// one round trip; only the request whose UPDATE actually affects a row
// (necessarily the first to arrive, since Postgres serializes concurrent
// UPDATEs to the same row) is allowed to proceed to create a membership.
// Every other concurrent request gets 0 affected rows back and is
// rejected here — before it can create a duplicate membership. No RPC or
// migration required.

async function acceptInvite(req, res, next) {
  try {
    const { token } = req.params;
    const userId    = req.user.id;

    // Fetch invite
    const { data: invite, error: invErr } = await supabaseAdmin
      .from('invite_links')
      .select('*, workspaces!inner(*)')
      .eq('token', token)
      .maybeSingle();

    if (invErr) throw new Error(invErr.message);
    if (!invite) throw new NotFoundError('Invite not found');
    if (new Date(invite.expires_at) < new Date()) throw new BusinessRuleError('This invite has expired');
    if (invite.used_at) throw new BusinessRuleError('This invite has already been used');

    // Check existing membership
    const { data: existingMember } = await supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', invite.workspace_id)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle();

    if (existingMember) throw new ConflictError('You are already a member of this workspace');

    // Issue C4 fix: atomically claim the invite before creating anything.
    const { data: claimedInvite, error: claimErr } = await supabaseAdmin
      .from('invite_links')
      .update({ used_at: new Date().toISOString(), used_by_user_id: userId })
      .eq('id', invite.id)
      .is('used_at', null)
      .select()
      .maybeSingle();

    if (claimErr) throw new Error(claimErr.message);
    if (!claimedInvite) {
      // Another concurrent request won the race and claimed it first.
      throw new BusinessRuleError('This invite has already been used');
    }

    // Get user display name
    const { data: user } = await supabaseAdmin.from('users').select('full_name').eq('id', userId).single();
    const displayName    = user?.full_name || 'New Member';

    // Create member
    const { data: member, error: memErr } = await supabaseAdmin
      .from('workspace_members')
      .insert({ workspace_id: invite.workspace_id, user_id: userId, role: 'member', display_name: displayName, invite_status: 'accepted', invited_at: new Date().toISOString(), joined_at: new Date().toISOString() })
      .select()
      .single();

    if (memErr) throw new Error(memErr.message);

    const workspace = invite.workspaces;

    // Notify admins
    const { data: admins } = await supabaseAdmin
      .from('workspace_members').select('id').eq('workspace_id', workspace.id).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);

    await notification.send({ type: 'invite_accepted', workspaceId: workspace.id, recipientIds: (admins || []).map((a) => a.id), variables: { actor: member.display_name, workspace: workspace.name } });

    await audit.log({ ...audit.fromReq(req), action: 'member.accepted', targetType: 'workspace_member', targetId: member.id });

    success(res, { workspace, member });
  } catch (err) { next(err); }
}

async function listInvites(req, res, next) {
  try {
    const { workspaceId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('invite_links')
      .select('*, created_by_member:workspace_members!created_by(display_name)')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const invites = (data || []).map((i) => ({ ...i, created_by_name: i.created_by_member?.display_name, created_by_member: undefined }));

    success(res, { invites });
  } catch (err) { next(err); }
}

async function revokeInvite(req, res, next) {
  try {
    const { workspaceId, inviteId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('invite_links').delete().eq('id', inviteId).eq('workspace_id', workspaceId).select('id').maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Invite not found');

    success(res, { message: 'Invite revoked.' });
  } catch (err) { next(err); }
}

module.exports = { createInvite, previewInvite, acceptInvite, listInvites, revokeInvite };
