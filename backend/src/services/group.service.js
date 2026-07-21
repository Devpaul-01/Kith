// src/services/group.service.js
//
// Behavior unchanged, including the batch-validate-then-batch-upsert
// pattern used for member additions.

const { supabaseAdmin } = require('../config/supabase');
const { NotFoundError } = require('../utils/errors');
const audit = require('./audit.service');
const { AUDIT_ACTIONS } = require('../constants/audit-actions');
const logger = require('../utils/logger');

async function listGroups({ workspaceId }) {
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

  return (groups || []).map((g) => ({
    ...g,
    member_count: (g.group_members || []).length,
    members: (g.group_members || []).map((gm) => gm.workspace_members),
    group_members: undefined,
  }));
}

async function createGroup({ workspaceId, name, description, memberIds = [], actorMemberId, actorCtx }) {
  const { data: group, error } = await supabaseAdmin
    .from('groups')
    .insert({ workspace_id: workspaceId, name, description: description || null, created_by: actorMemberId })
    .select()
    .single();

  if (error) throw new Error(error.message);

  if (memberIds.length) {
    const { data: validMembers } = await supabaseAdmin
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', memberIds)
      .is('deleted_at', null);

    const validMemberIds = new Set((validMembers || []).map((m) => m.id));
    const rows = memberIds
      .filter((id) => validMemberIds.has(id))
      .map((id) => ({ group_id: group.id, workspace_member_id: id, added_by: actorMemberId }));

    if (rows.length) {
      const { error: gmErr } = await supabaseAdmin
        .from('group_members')
        .upsert(rows, { onConflict: 'group_id,workspace_member_id', ignoreDuplicates: true });
      if (gmErr) {
        logger.error('Failed to add initial members to new group', { groupId: group.id, error: gmErr.message });
      }
    }
  }

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.GROUP_CREATED, targetType: 'group', targetId: group.id, metadata: { name: group.name, initial_member_count: memberIds.length } });

  return group;
}

async function getGroup({ workspaceId, groupId }) {
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

  return {
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
  };
}

async function updateGroup({ workspaceId, groupId, data, actorCtx }) {
  const updates = {};
  if (data.name        !== undefined) updates.name        = data.name;
  if (data.description !== undefined) updates.description = data.description;

  if (!Object.keys(updates).length) {
    const { data: g } = await supabaseAdmin.from('groups').select('*').eq('id', groupId).single();
    return g;
  }

  updates.updated_at = new Date().toISOString();

  const { data: group, error } = await supabaseAdmin
    .from('groups').update(updates).eq('id', groupId).eq('workspace_id', workspaceId).select().maybeSingle();

  if (error) throw new Error(error.message);
  if (!group) throw new NotFoundError('Group not found');

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.GROUP_UPDATED, targetType: 'group', targetId: groupId, metadata: { fields: Object.keys(updates).filter((k) => k !== 'updated_at') } });

  return group;
}

async function addGroupMembers({ workspaceId, groupId, memberIds, actorMemberId, actorCtx }) {
  const { data: groupCheck } = await supabaseAdmin.from('groups').select('id').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();
  if (!groupCheck) throw new NotFoundError('Group not found');

  const { data: validMembers } = await supabaseAdmin
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .in('id', memberIds)
    .is('deleted_at', null);

  const validMemberIds = new Set((validMembers || []).map((m) => m.id));
  const validIds        = memberIds.filter((id) => validMemberIds.has(id));
  const skippedInvalid   = memberIds.length - validIds.length;

  let added = 0, alreadyInGroup = 0;

  if (validIds.length) {
    const rows = validIds.map((id) => ({ group_id: groupId, workspace_member_id: id, added_by: actorMemberId }));

    const { data: inserted, error } = await supabaseAdmin
      .from('group_members')
      .upsert(rows, { ignoreDuplicates: true, onConflict: 'group_id,workspace_member_id' })
      .select('id');

    if (error) throw new Error(error.message);

    added          = (inserted || []).length;
    alreadyInGroup = validIds.length - added;
  }

  if (added > 0) {
    await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.GROUP_MEMBERS_ADDED, targetType: 'group', targetId: groupId, metadata: { added_count: added } });
  }

  // Preserves the original response contract: `already_in_group` covers
  // any member_id that wasn't newly added, whether because it was
  // invalid or because it was already in the group.
  return { added_count: added, already_in_group: alreadyInGroup + skippedInvalid };
}

async function removeGroupMember({ groupId, memberId, actorCtx }) {
  const { error, count } = await supabaseAdmin
    .from('group_members')
    .delete({ count: 'exact' })
    .eq('group_id', groupId)
    .eq('workspace_member_id', memberId);

  if (error) throw new Error(error.message);
  if (count > 0) {
    await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.GROUP_MEMBER_REMOVED, targetType: 'group', targetId: groupId, metadata: { workspace_member_id: memberId } });
  }
}

async function deleteGroup({ workspaceId, groupId, actorCtx }) {
  const { data, error } = await supabaseAdmin.from('groups').delete().eq('id', groupId).eq('workspace_id', workspaceId).select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Group not found');

  await audit.log({ ...actorCtx, action: AUDIT_ACTIONS.GROUP_DELETED, targetType: 'group', targetId: groupId });
}

module.exports = { listGroups, createGroup, getGroup, updateGroup, addGroupMembers, removeGroupMember, deleteGroup };
