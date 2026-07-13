// src/controllers/member.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../utils/errors');
const { createMemberSchema, updateMemberSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const logger = require('../utils/logger');
const { computeEngagement } = require('../services/engagement.service');

async function listMembers(req, res, next) {
  try {
    const { workspaceId }     = req.params;
    const isAdmin             = req.member.role === 'admin';
    const { search, sort }    = req.query;
    const filterRole          = req.query['filter[role]'];
    const filterProxy         = req.query['filter[is_proxy]'];

    let query = supabaseAdmin
      .from('workspace_members')
      .select('*, users:user_id(email, country_of_residence, timezone)')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);

    if (filterRole  !== undefined) query = query.eq('role', filterRole);
    if (filterProxy !== undefined) query = query.eq('is_proxy', filterProxy === 'true');
    if (search) query = query.ilike('display_name', `%${search}%`);

    const sortField = sort?.replace('-', '') || 'display_name';
    const ascending = !sort?.startsWith('-');
    const safeSort  = ['display_name', 'joined_at'].includes(sortField) ? sortField : 'display_name';
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
// Issue 15 fix: removed the inline `if (!isAdmin && !isSelf) throw ForbiddenError`
// check at the top of this function. Authorization is now enforced at the route
// layer via `requireSelfOrAdmin()` in workspace.routes.js before this function
// is ever called. Keeping duplicate checks in both layers was confusing and
// made the authorization surface harder to audit.
// The admin-only field restriction check is still here — that is field-level
// (not resource-level) authorization and belongs in the controller.

async function updateMember(req, res, next) {
  try {
    const data                      = updateMemberSchema.parse(req.body);
    const { workspaceId, memberId } = req.params;
    const isAdmin                   = req.member.role === 'admin';

    // Issue 15: removed top-level `if (!isAdmin && !isSelf) throw ForbiddenError`
    // requireSelfOrAdmin() in the route already guarantees this caller is either
    // an admin OR the member being updated.

    const adminOnlyFields      = ['role', 'is_proxy', 'proxy_managed_by', 'is_active', 'admin_notes', 'relationship_category'];
    const memberEditableFields = ['display_name', 'relationship_to_head', 'date_of_birth'];

    // Field-level restriction: members cannot touch admin-only fields even on their own record
    if (!isAdmin) {
      for (const field of adminOnlyFields) {
        if (data[field] !== undefined) throw new ForbiddenError(`Field '${field}' can only be edited by admins`);
      }
    }

    const { data: current, error: fetchErr } = await supabaseAdmin
      .from('workspace_members').select('*').eq('id', memberId).eq('workspace_id', workspaceId).maybeSingle();

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
    // Issue M4-adjacent fix: profile-audit inserts were previously done one
    // row at a time inside this loop (await'd sequentially). Now collected
    // and written in a single batch insert after the loop, consistent with
    // the batch-upsert pattern already used elsewhere (auth.controller.js
    // updateContacts).
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

    success(res, { member });
  } catch (err) { next(err); }
}

async function deleteMember(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const { force }                 = req.query;

    const { data: target, error: fetchErr } = await supabaseAdmin
      .from('workspace_members').select('*').eq('id', memberId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();

    if (fetchErr) throw new Error(fetchErr.message);
    if (!target) throw new NotFoundError('Member not found');

    if (target.role === 'admin' && req.member.id === memberId) {
      const { data: admins } = await supabaseAdmin
        .from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('role', 'admin').eq('is_active', true).is('deleted_at', null);
      if ((admins || []).length <= 1) throw new BusinessRuleError('Cannot remove the last admin');
    }

    // Issue C6 fix: `error` was previously ignored on this count query — the
    // same fail-open pattern as container.controller.js's deleteContainer.
    // A failed count query would silently fall through to `hasEntries =
    // false`, allowing a member with confirmed ledger entries to be
    // hard-deleted (`force=true`) if the guard itself couldn't be verified.
    const { count, error: countErr } = await supabaseAdmin
      .from('ledger_entries').select('*', { count: 'exact', head: true }).eq('contributor_id', memberId).eq('status', 'confirmed');
    if (countErr) throw new Error(countErr.message);
    const hasEntries = count > 0;

    if (hasEntries && force === 'true') {
      throw new BusinessRuleError('Cannot hard-delete a member with confirmed ledger entries');
    } else if (!hasEntries && force === 'true') {
      await supabaseAdmin.from('workspace_members').delete().eq('id', memberId);
    } else {
      await supabaseAdmin.from('workspace_members').update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', memberId);
    }

    await audit.log({ ...audit.fromReq(req), action: 'member.removed', targetType: 'workspace_member', targetId: memberId });

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
// Issue M1 fix: this previously ran 2 queries PER MEMBER via
// `Promise.all((members||[]).map(async (m) => {...}))` — O(2N) round trips
// for the exact same computation `background.workers.js`'s
// `createEngagementCheckWorker` already batches into 2 total queries via
// upfront fetch + in-memory Map lookups. Now delegates to the shared
// `services/engagement.service.js` helper (imported at the top of this
// file) so both the worker and this endpoint share one implementation
// instead of two divergent ones.

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
