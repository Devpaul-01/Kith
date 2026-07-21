// src/controllers/group.controller.js
//
// DB/audit logic lives in services/group.service.js.

const { noContent, success } = require('../utils/response');
const { createGroupSchema, updateGroupSchema, addGroupMembersSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const groupService = require('../services/group.service');

async function listGroups(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const groups = await groupService.listGroups({ workspaceId });
    success(res, { groups });
  } catch (err) { next(err); }
}

async function createGroup(req, res, next) {
  try {
    const data            = createGroupSchema.parse(req.body);
    const { workspaceId } = req.params;

    const group = await groupService.createGroup({
      workspaceId,
      name: data.name,
      description: data.description,
      memberIds: data.member_ids || [],
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { group }, 201);
  } catch (err) { next(err); }
}

async function getGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;
    const result = await groupService.getGroup({ workspaceId, groupId });
    success(res, result);
  } catch (err) { next(err); }
}

async function updateGroup(req, res, next) {
  try {
    const data                     = updateGroupSchema.parse(req.body);
    const { workspaceId, groupId } = req.params;
    const group = await groupService.updateGroup({ workspaceId, groupId, data, actorCtx: audit.fromReq(req) });
    success(res, { group });
  } catch (err) { next(err); }
}

async function addGroupMembers(req, res, next) {
  try {
    const data                     = addGroupMembersSchema.parse(req.body);
    const { workspaceId, groupId } = req.params;

    const result = await groupService.addGroupMembers({
      workspaceId, groupId,
      memberIds: data.member_ids,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, result);
  } catch (err) {
    next(err);
  }
}

async function removeGroupMember(req, res, next) {
  try {
    const { groupId, memberId } = req.params;
    await groupService.removeGroupMember({ groupId, memberId, actorCtx: audit.fromReq(req) });
    noContent(res);
  } catch (err) { next(err); }
}

async function deleteGroup(req, res, next) {
  try {
    const { workspaceId, groupId } = req.params;
    await groupService.deleteGroup({ workspaceId, groupId, actorCtx: audit.fromReq(req) });
    success(res, { message: 'Group deleted.' });
  } catch (err) { next(err); }
}

module.exports = { listGroups, createGroup, getGroup, updateGroup, addGroupMembers, removeGroupMember, deleteGroup };
