// src/controllers/group.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError }      = require('../utils/errors');
const { createGroupSchema, updateGroupSchema, addGroupMembersSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const logger = require('../utils/logger');

async function listGroups(req, res, next) {
  try {
    const { workspaceId } = req.params;

    const { data: groups, error } = await supabaseAdmin
      .from('groups')
      .select(`
        id, 
        name, 
        description, 
        created_at,
        group_members!group_members_group_id_fkey (
          id,
          workspace_members!group_members_workspace_member_id_fkey (
            id,
            display_name,
            role,
            is_proxy
          )
        )
      `)
      .eq('workspace_id', workspaceId)
      .order('name', { ascending: true });

    if (error) throw new Error(error.message);

    const result = (groups || []).map((g) => ({
      ...g,
      member_count: (g.group_members || []).length,
      members: (g.group_members || []).map((gm) => gm.workspace_members),
      group_members: undefined,
    }));

    success(res, { groups: result });
  } catch (err) { next(err); }
}

async function createGroup(req, res, next) {
  try {
    const data            = createGroupSchema.parse(req.body);
    const { workspaceId } = req.params;

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .insert({ workspace_id: workspaceId, name: data.name, description: data.description || null, created_by: req.member.id })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Batch-validates all member ids in one query, then batch-inserts all
    // valid rows in one call — consistent with the batch-upsert pattern
    // used in auth.controller.js#updateContacts and participant.controller.js.
    if ((data.member_ids || []).length) {
      const { data: validMembers } = await supabaseAdmin
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', workspaceId)
        .in('id', data.member_ids)
        .is('deleted_at', null);

      const validMemberIds = new Set((validMembers || []).map((m) => m.id));
      const rows = data.member_ids
        .filter((id) => validMemberIds.has(id))
        .map((id) => ({ group_id: group.id, workspace_member_id: id, added_by: req.member.id }));

      if (rows.length) {
        const { error: gmErr } = await supabaseAdmin
          .from('group_members')
          .upsert(rows, { onConflict: 'group_id,workspace_member_id', ignoreDuplicates: true });
        if (gmErr) {
          logger.error('Failed to add initial members to new group', { groupId: group.id, error: gmErr.message });
        }
      }
    }

    // Audit finding 5.1: group.controller.js previously never logged
    // anything — creating/updating/deleting a group, or adding/removing
    // members, was completely silent in the activity feed.
    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.GROUP_CREATED, targetType: 'group', targetId: group.id, metadata: { name: group.name, initial_member_count: (data.member_ids || []).length } });

    success(res, { group }, 201);
  } catch (err) { next(err); }
}

async function getGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;

    const { data: group, error } = await supabaseAdmin
      .from('groups')
      .select(`
        *,
        group_members!group_members_group_id_fkey (
          id,
          added_at,
          added_by,
          workspace_members!group_members_workspace_member_id_fkey (
            id,
            display_name,
            role,
            is_proxy,
            relationship_to_head,
            relationship_category
          )
        )
      `)
      .eq('id', groupId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!group) throw new NotFoundError('Group not found');

    const members = (group.group_members || []).map(gm => ({
      ...gm.workspace_members,
      added_at: gm.added_at,
      added_by: gm.added_by
    }));

    success(res, { 
      group: {
        id: group.id,
        name: group.name,
        description: group.description,
        workspace_id: group.workspace_id,
        created_by: group.created_by,
        created_at: group.created_at,
        updated_at: group.updated_at
      },
      members 
    });
  } catch (err) { next(err); }
}

async function updateGroup(req, res, next) {
  try {
    const data                     = updateGroupSchema.parse(req.body);
    const { workspaceId, groupId } = req.params;

    const updates = {};
    if (data.name        !== undefined) updates.name        = data.name;
    if (data.description !== undefined) updates.description = data.description;

    if (!Object.keys(updates).length) {
      const { data: g } = await supabaseAdmin.from('groups').select('*').eq('id', groupId).single();
      return success(res, { group: g });
    }

    updates.updated_at = new Date().toISOString();

    const { data: group, error } = await supabaseAdmin
      .from('groups').update(updates).eq('id', groupId).eq('workspace_id', workspaceId).select().maybeSingle();

    if (error) throw new Error(error.message);
    if (!group) throw new NotFoundError('Group not found');

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.GROUP_UPDATED, targetType: 'group', targetId: groupId, metadata: { fields: Object.keys(updates).filter((k) => k !== 'updated_at') } });

    success(res, { group });
  } catch (err) { next(err); }
}

async function addGroupMembers(req, res, next) {
  try {
    const data                     = addGroupMembersSchema.parse(req.body);
    const { workspaceId, groupId } = req.params;

    const { data: groupCheck } = await supabaseAdmin.from('groups').select('id').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();
    if (!groupCheck) throw new NotFoundError('Group not found');

    // Batch-validates then batch-upserts in 2 total queries regardless of N.
    const { data: validMembers } = await supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', data.member_ids)
      .is('deleted_at', null);

    const validMemberIds = new Set((validMembers || []).map((m) => m.id));
    const validIds        = data.member_ids.filter((id) => validMemberIds.has(id));
    const skippedInvalid   = data.member_ids.length - validIds.length;

    let added = 0, alreadyInGroup = 0;

    if (validIds.length) {
      const rows = validIds.map((id) => ({ group_id: groupId, workspace_member_id: id, added_by: req.member.id }));

      const { data: inserted, error } = await supabaseAdmin
        .from('group_members')
        .upsert(rows, { ignoreDuplicates: true, onConflict: 'group_id,workspace_member_id' })
        .select('id');

      if (error) throw new Error(error.message);

      added          = (inserted || []).length;
      alreadyInGroup = validIds.length - added;
    }

    if (added > 0) {
      await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.GROUP_MEMBERS_ADDED, targetType: 'group', targetId: groupId, metadata: { added_count: added } });
    }

    // Preserves the original response contract: `already_in_group` covers
    // any member_id that wasn't newly added, whether because it was
    // invalid or because it was already in the group — the original loop
    // didn't distinguish the two either (both fell into the same
    // `continue` / increment path).
    success(res, { added_count: added, already_in_group: alreadyInGroup + skippedInvalid });
  } catch (err) { 
    next(err); 
  }
}

async function removeGroupMember(req, res, next) {
  try {
    const { groupId, memberId } = req.params;
    const { error, count } = await supabaseAdmin
      .from('group_members')
      .delete({ count: 'exact' })
      .eq('group_id', groupId)
      .eq('workspace_member_id', memberId);

    if (error) throw new Error(error.message);
    if (count > 0) {
      await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.GROUP_MEMBER_REMOVED, targetType: 'group', targetId: groupId, metadata: { workspace_member_id: memberId } });
    }

    noContent(res);
  } catch (err) { next(err); }
}

async function deleteGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;
    const { data, error } = await supabaseAdmin.from('groups').delete().eq('id', groupId).eq('workspace_id', workspaceId).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Group not found');

    await audit.log({ ...audit.fromReq(req), action: AUDIT_ACTIONS.GROUP_DELETED, targetType: 'group', targetId: groupId });

    success(res, { message: 'Group deleted.' });
  } catch (err) { next(err); }
}

module.exports = { listGroups, createGroup, getGroup, updateGroup, addGroupMembers, removeGroupMember, deleteGroup };
