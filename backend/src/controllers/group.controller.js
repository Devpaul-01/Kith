// src/controllers/group.controller.js
const { supabaseAdmin }      = require('../config/supabase');
const { success, noContent } = require('../utils/response');
const { NotFoundError }      = require('../utils/errors');
const { createGroupSchema, updateGroupSchema, addGroupMembersSchema } = require('../validators/workspace.validator');

async function listGroups(req, res, next) {
  try {
    const { workspaceId } = req.params;

    // First, get all groups
    const { data: groups, error: groupsError } = await supabaseAdmin
      .from('groups')
      .select('id, name, description, created_at')
      .eq('workspace_id', workspaceId)
      .order('name', { ascending: true });

    if (groupsError) throw new Error(groupsError.message);

    if (!groups || groups.length === 0) {
      return success(res, { groups: [] });
    }

    // Then, get all group members for these groups
    const groupIds = groups.map(g => g.id);
    
    const { data: groupMembers, error: membersError } = await supabaseAdmin
      .from('group_members')
      .select(`
        id,
        group_id,
        workspace_member_id,
        workspace_members!inner (
          id,
          display_name,
          role,
          is_proxy
        )
      `)
      .in('group_id', groupIds);

    if (membersError) throw new Error(membersError.message);

    // Group members by group_id
    const membersByGroup = {};
    (groupMembers || []).forEach(gm => {
      if (!membersByGroup[gm.group_id]) {
        membersByGroup[gm.group_id] = [];
      }
      membersByGroup[gm.group_id].push(gm.workspace_members);
    });

    // Build the result
    const result = groups.map(group => ({
      ...group,
      member_count: (membersByGroup[group.id] || []).length,
      members: membersByGroup[group.id] || []
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

    if ((data.member_ids || []).length) {
      for (const memberId of data.member_ids) {
        const { data: memberCheck } = await supabaseAdmin
          .from('workspace_members').select('id').eq('id', memberId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
        if (memberCheck) {
          await supabaseAdmin.from('group_members').upsert({ group_id: group.id, workspace_member_id: memberId, added_by: req.member.id }, { ignoreDuplicates: true });
        }
      }
    }

    success(res, { group }, 201);
  } catch (err) { next(err); }
}

async function getGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;

    const { data: group, error } = await supabaseAdmin
      .from('groups').select('*').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();

    if (error) throw new Error(error.message);
    if (!group) throw new NotFoundError('Group not found');

    const { data: members } = await supabaseAdmin
      .from('group_members')
      .select('workspace_members!inner(id, display_name, role, is_proxy, relationship_to_head, relationship_category)')
      .eq('group_id', groupId);

    success(res, { group, members: (members || []).map((m) => m.workspace_members) });
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

    success(res, { group });
  } catch (err) { next(err); }
}

async function addGroupMembers(req, res, next) {
  try {
    const data                     = addGroupMembersSchema.parse(req.body);
    const { workspaceId, groupId } = req.params;

    const { data: groupCheck } = await supabaseAdmin.from('groups').select('id').eq('id', groupId).eq('workspace_id', workspaceId).maybeSingle();
    if (!groupCheck) throw new NotFoundError('Group not found');

    let added = 0, alreadyInGroup = 0;

    for (const memberId of data.member_ids) {
      const { data: memberCheck } = await supabaseAdmin.from('workspace_members').select('id').eq('id', memberId).eq('workspace_id', workspaceId).is('deleted_at', null).maybeSingle();
      if (!memberCheck) continue;

      const { data: inserted } = await supabaseAdmin
        .from('group_members')
        .upsert({ group_id: groupId, workspace_member_id: memberId, added_by: req.member.id }, { ignoreDuplicates: true, onConflict: 'group_id,workspace_member_id' })
        .select('id')
        .maybeSingle();

      if (inserted) added++; else alreadyInGroup++;
    }

    success(res, { added_count: added, already_in_group: alreadyInGroup });
  } catch (err) { next(err); }
}

async function removeGroupMember(req, res, next) {
  try {
    const { groupId, memberId } = req.params;
    await supabaseAdmin.from('group_members').delete().eq('group_id', groupId).eq('workspace_member_id', memberId);
    noContent(res);
  } catch (err) { next(err); }
}

async function deleteGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;
    const { data, error } = await supabaseAdmin.from('groups').delete().eq('id', groupId).eq('workspace_id', workspaceId).select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Group not found');
    success(res, { message: 'Group deleted.' });
  } catch (err) { next(err); }
}

module.exports = { listGroups, createGroup, getGroup, updateGroup, addGroupMembers, removeGroupMember, deleteGroup };
