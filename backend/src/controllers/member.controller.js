// src/controllers/member.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const { createMemberSchema, updateMemberSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const notification = require('../services/notification.service');
const logger = require('../utils/logger');
const { computeEngagement } = require('../services/engagement.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const { containsPattern } = require('../utils/ilike');
const { invalidateMembership } = require('../services/membership-cache.service');
const { getSort } = require('../utils/sorting');

async function listMembers(req, res, next) {
  try {
    const { workspaceId }     = req.params;
    const isAdmin             = req.member.role === 'admin';
    const { search }          = req.query;
    const filterRole          = req.query['filter[role]'];
    const filterProxy         = req.query['filter[is_proxy]'];

    let query = supabaseAdmin
      .from('workspace_members')
      .select('*, users:user_id(email, country_of_residence, timezone)')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);

    if (filterRole  !== undefined) query = query.eq('role', filterRole);
    if (filterProxy !== undefined) query = query.eq('is_proxy', filterProxy === 'true');
    // Issue L7-class fix: search input is escaped before being embedded in
    // the ILIKE pattern (shared with workspace.controller.js#searchWorkspace
    // via utils/ilike.js) so a literal '%' or '_' in the search term can't
    // silently widen/narrow the match (audit finding 5.3).
    if (search) query = query.ilike('display_name', containsPattern(search));

    // Audit 6.2: shared sort helper (utils/sorting.js).
    const { field: safeSort, ascending } = getSort(req.query, { allowed: ['display_name', 'joined_at'], defaultField: 'display_name' });
    query = query.order(safeSort, { ascending });

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const members = (data || []).map((m) => {
      const flat = { ...m, email: m.users?.email, country_of_residence: m.users?.country_of_residence, timezone: m.users?.timezone, users: undefined };
      if (!isAdmin) {
        const { admin_notes, last_active_at, contribution_streak_months, ...limited } = flat;
        return limited;
      }
      return flat;
    });

    const { data: all } = await supabaseAdmin
      .from('workspace_members').select('role, is_active, is_proxy, deleted_at').eq('workspace_id', workspaceId);

    const meta = {
      total:        (all || []).length,
      admins_count: (all || []).filter((m) => m.role === 'admin' && !m.deleted_at).length,
      proxy_count:  (all || []).filter((m) => m.is_proxy && !m.deleted_at).length,
      active_count: (all || []).filter((m) => m.is_active && !m.deleted_at).length,
    };

    success(res, { members, meta });
  } catch (err) { next(err); }
}

async function createMember(req, res, next) {
  try {
    const data            = createMemberSchema.parse(req.body);
    const { workspaceId } = req.params;

    if (data.is_proxy && data.proxy_managed_by) {
      const { data: adminCheck } = await supabaseAdmin
        .from('workspace_members').select('id').eq('id', data.proxy_managed_by).eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).maybeSingle();
      if (!adminCheck) throw new BusinessRuleError('proxy_managed_by must be an active admin member');
    }

    const { data: member, error } = await supabaseAdmin
      .from('workspace_members')
      .insert({
        workspace_id:          workspaceId,
        display_name:          data.display_name,
        is_proxy:              data.is_proxy,
        proxy_managed_by:      data.proxy_managed_by      || null,
        role:                  data.role,
        relationship_to_head:  data.relationship_to_head  || null,
        relationship_category: data.relationship_category,
        date_of_birth:         data.date_of_birth         || null,
        admin_notes:           data.admin_notes           || null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Audit finding 5.1: createMember previously never logged anything —
    // a direct add-a-member action (distinct from the invite-link flow,
    // which already logs MEMBER_INVITED / MEMBER_ACCEPTED) was completely
    // silent in the activity feed and admin audit log.
    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.MEMBER_CREATED, targetType: 'workspace_member', targetId: member.id, metadata: { display_name: member.display_name, is_proxy: member.is_proxy } });

    success(res, { member }, 201);
  } catch (err) { next(err); }
}

async function getMember(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const isAdmin = req.member.role === 'admin';

    const { data, error } = await supabaseAdmin
      .from('workspace_members')
      .select('*, users:user_id(email, country_of_residence, timezone, bio)')
      .eq('id', memberId)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Member not found');

    const member = { ...data, email: data.users?.email, country_of_residence: data.users?.country_of_residence, timezone: data.users?.timezone, bio: data.users?.bio, users: undefined };
    if (!isAdmin) delete member.admin_notes;

    success(res, { member });
  } catch (err) { next(err); }
}

// ── Update member ──────────────────────────────────────────────────
//
// Resource-level authorization (caller must be an admin OR the member
// being updated) is enforced at the route layer via requireSelfOrAdmin()
// in workspace.routes.js, not duplicated here. The admin-only field
// restriction below is field-level authorization and belongs in the
// controller.

async function updateMember(req, res, next) {
  try {
    const data                      = updateMemberSchema.parse(req.body);
    const { workspaceId, memberId } = req.params;
    const isAdmin                   = req.member.role === 'admin';

    const adminOnlyFields      = ['role', 'is_proxy', 'proxy_managed_by', 'is_active', 'admin_notes', 'relationship_category'];
    const memberEditableFields = ['display_name', 'relationship_to_head', 'date_of_birth'];

    // Field-level restriction: members cannot touch admin-only fields even on their own record
    if (!isAdmin) {
      for (const field of adminOnlyFields) {
        if (data[field] !== undefined) throw new ForbiddenError(`Field '${field}' can only be edited by admins`);
      }
    }

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from('workspace_members').select('*, users:user_id(id)').eq('id', memberId).eq('workspace_id', workspaceId).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!current) throw new NotFoundError('Member not found');

    // Optimistic lock
    if (data.version && current.updated_at !== data.version) {
      throw new BusinessRuleError('Record was modified by another request. Please refresh and try again.');
    }

    // Last-admin guard
    if (isAdmin && data.role === 'member' && current.role === 'admin') {
      const { data: admins } = await supabaseAdmin
        .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);
      if ((admins || []).length <= 1) throw new BusinessRuleError('Cannot demote the last admin. Promote another member first.');
    }

    if (data.proxy_managed_by) {
      const { data: adminCheck } = await supabaseAdmin
        .from('workspace_members').select('id').eq('id', data.proxy_managed_by).eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).maybeSingle();
      if (!adminCheck) throw new BusinessRuleError('proxy_managed_by must be an active admin');
    }

    const allowedFields = isAdmin
      ? ['display_name', 'relationship_to_head', 'relationship_category', 'date_of_birth', 'role', 'is_proxy', 'proxy_managed_by', 'is_active', 'admin_notes']
      : memberEditableFields;

    const updates = {};
    // Profile-audit rows are collected and written in a single batch
    // insert after the loop rather than per-field, consistent with the
    // batch-upsert pattern used elsewhere (auth.controller.js#updateContacts).
    const auditRows = [];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates[field] = data[field];
        if (String(current[field]) !== String(data[field])) {
          auditRows.push({
            workspace_member_id: memberId,
            changed_by:          req.member.id,
            field_name:          field,
            old_value:           current[field] != null ? String(current[field]) : null,
            new_value:           data[field]    != null ? String(data[field])    : null,
            change_source:       isAdmin ? 'admin' : 'member',
          });
        }
      }
    }

    if (!Object.keys(updates).length) return success(res, { member: current });

    updates.updated_at = new Date().toISOString();
    const { data: member, error } = await supabaseAdmin.from('workspace_members').update(updates).eq('id', memberId).select().single();
    if (error) throw new Error(error.message);

    if (auditRows.length) {
      const { error: auditErr } = await supabaseAdmin.from('member_profile_audit').insert(auditRows);
      if (auditErr) {
        // The member update itself already succeeded — a failure to write
        // the profile-change audit trail shouldn't turn a successful
        // update into a 500 for the client. Log loudly instead.
        logger.error('Failed to write member_profile_audit rows', { memberId, error: auditErr.message });
      }
    }

    // Authorization-relevant fields (role / is_active / is_proxy /
    // proxy_managed_by) changed — invalidate this member's cached
    // requireMembership entry immediately rather than waiting out the
    // (up to 30s) cache TTL, so a demotion/deactivation takes effect on
    // the member's very next request. See membership-cache.service.js.
    const authRelevantChanged = ['role', 'is_active', 'is_proxy', 'proxy_managed_by'].some((f) => updates[f] !== undefined);
    if (authRelevantChanged && current.users?.id) {
      await invalidateMembership(workspaceId, current.users.id);
    }

    success(res, { member });
  } catch (err) { next(err); }
}

async function deleteMember(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const { force }                 = req.query;

    const { data: target, error: fetchErr } = await supabaseAdmin
      .from('workspace_members').select('*, users:user_id(id)').eq('id', memberId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!target) throw new NotFoundError('Member not found');

    if (target.role === 'admin' && req.member.id === memberId) {
      const { data: admins } = await supabaseAdmin
        .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);
      if ((admins || []).length <= 1) throw new BusinessRuleError('Cannot remove the last admin');
    }

    // `error` is checked explicitly here (not just `data`) — a failed
    // count query fails CLOSED (blocks hard-delete) rather than silently
    // falling through to `hasEntries = false`.
    const { count, error: countErr } = await supabaseAdmin
      .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('contributor_id', memberId).eq('status', 'confirmed');
    if (countErr) throw new Error(countErr.message);
    const hasEntries = count > 0;

    let hardDeleted = false;

    if (hasEntries && force === 'true') {
      throw new BusinessRuleError('Cannot hard-delete a member with confirmed ledger entries');
    } else if (!hasEntries && force === 'true') {
      await supabaseAdmin.from('workspace_members').delete().eq('id', memberId);
      hardDeleted = true;
    } else {
      await supabaseAdmin.from('workspace_members').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', memberId);
    }

    // Notification finding (audit 5.5): 'member_removed' was a fully
    // defined template that nothing ever sent. Only sent on the
    // soft-delete path — on a hard delete the row (and any notification
    // referencing it via recipient_id, which cascades) is gone by the
    // time delivery would run, so there's no safe recipient to notify.
    if (!hardDeleted) {
      try {
        await notification.send({
          type:          'member_removed',
          workspaceId,
          recipientIds:  [memberId],
          referenceType: 'member',
          referenceId:   memberId,
          variables:     { workspace: req.workspace?.name || 'the workspace' },
        });
      } catch (notifErr) {
        logger.error('Failed to send member_removed notification', { memberId, error: notifErr.message });
      }
    }

    // Removed members should lose access immediately, not after the
    // membership cache's TTL expires.
    if (target.users?.id) {
      await invalidateMembership(workspaceId, target.users.id);
    }

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.MEMBER_REMOVED, targetType: 'workspace_member', targetId: memberId });

    success(res, { message: 'Member removed.' });
  } catch (err) { next(err); }
}

async function getProfileHistory(req, res, next) {
  try {
    const { memberId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('member_profile_audit')
      .select('*, changed_by_member:workspace_members!changed_by(display_name)')
      .eq('workspace_member_id', memberId)
      .order('changed_at', { ascending: false });

    if (error) throw new Error(error.message);

    const history = (data || []).map((r) => ({
      ...r,
      changed_by_name: r.changed_by_member?.display_name,
      changed_by_member: undefined,
    }));

    success(res, { history });
  } catch (err) { next(err); }
}

async function getContributionSummary(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;

    const { data: ledger } = await supabaseAdmin
      .from('ledger_entries')
      .select('id, container_id, base_amount, status, confirmed_at')
      .eq('contributor_id', memberId);

    const confirmed       = (ledger || []).filter((le) => le.status === 'confirmed');
    const containerIds    = [...new Set((ledger || []).map((le) => le.container_id))];
    const lastContribDate = confirmed.length ? confirmed.map((le) => le.confirmed_at).sort().pop()?.split('T')[0] : null;

    const { data: participations } = await supabaseAdmin
      .from('container_participants')
      .select('id, container_id, containers!inner(name, workspace_id), contributor_targets(target_amount, target_currency, is_current, cycle_id)')
      .eq('workspace_member_id', memberId)
      .eq('containers.workspace_id', workspaceId);

    const containers = (participations || []).map((p) => {
      const paidBase = (ledger || []).filter((le) => le.container_id === p.container_id && le.status === 'confirmed').reduce((s, le) => s + parseFloat(le.base_amount || 0), 0);
      const t        = (p.contributor_targets || []).find((ct) => ct.is_current && ct.cycle_id === null);
      const target   = parseFloat(t?.target_amount || 0);
      return { container_name: p.containers?.name, paid_base_amount: paidBase, target_amount: t?.target_amount, target_currency: t?.target_currency, status: paidBase >= target ? 'paid' : 'pending' };
    });

    success(res, {
      total_containers:          containerIds.length,
      total_confirmed_count:     confirmed.length,
      total_paid_base_currency:  confirmed.reduce((s, le) => s + parseFloat(le.base_amount || 0), 0),
      last_contribution_date:    lastContribDate,
      containers,
    });
  } catch (err) { next(err); }
}

// ── Member engagement ──────────────────────────────────────────────
//
// Delegates to the shared services/engagement.service.js helper so both
// this endpoint and background.workers.js's engagement-check worker
// share one batched (2-query, not O(2N)) implementation.

async function getMemberEngagement(req, res, next) {
  try {
    const { workspaceId } = req.params;

    const { data: members, error } = await supabaseAdmin
      .from('workspace_members')
      .select('id, display_name, last_active_at')
      .eq('workspace_id', workspaceId)
      .eq('is_proxy', false)
      .is('deleted_at', null);

    if (error) throw new Error(error.message);

    const result = await computeEngagement(members || []);

    success(res, { members: result });
  } catch (err) { next(err); }
}

module.exports = {
  listMembers,
  createMember,
  getMember,
  updateMember,
  deleteMember,
  getProfileHistory,
  getContributionSummary,
  getMemberEngagement,
};
