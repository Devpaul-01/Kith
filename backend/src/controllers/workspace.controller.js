// src/controllers/workspace.controller.js
//
// CRUD/settings/announce/avatar logic lives in services/workspace.service.js.
// This file parses requests, applies validation schemas, calls the
// service, and shapes responses.

const { success } = require('../utils/response');
const { uploadFileSchema }  = require('../validators/ledger.validator');
const {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  updateSettingsSchema,
  announceSchema,
} = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const workspaceService = require('../services/workspace.service');

async function listWorkspaces(req, res, next) {
  try {
    const memberships = await workspaceService.listWorkspacesForUser({ userId: req.user.id });
    success(res, { memberships });
  } catch (err) { next(err); }
}

async function createWorkspace(req, res, next) {
  try {
    const data = createWorkspaceSchema.parse(req.body);
    const result = await workspaceService.createWorkspace({ userId: req.user.id, ...data });
    success(res, result, 201);
  } catch (err) { next(err); }
}

async function getWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const workspace = await workspaceService.getWorkspaceById({ workspaceId });
    success(res, { workspace, current_member: req.member });
  } catch (err) { next(err); }
}

async function getAvatarUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const { workspaceId } = req.params;
    const result = await workspaceService.generateWorkspaceAvatarUploadUrl({
      workspaceId,
      filename:    data.filename,
      contentType: data.content_type,
      fileSize:    data.file_size,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function updateWorkspace(req, res, next) {
  try {
    const data = updateWorkspaceSchema.parse(req.body);
    const { workspaceId } = req.params;
    const workspace = await workspaceService.updateWorkspace({ workspaceId, data, actorCtx: audit.fromReq(req) });
    success(res, { workspace });
  } catch (err) { next(err); }
}

async function deleteWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    await workspaceService.deleteWorkspace({ workspaceId, actorCtx: audit.fromReq(req) });
    success(res, { message: 'Workspace deleted.' });
  } catch (err) { next(err); }
}

async function getSettings(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const settings = await workspaceService.getSettings({ workspaceId });
    success(res, { settings });
  } catch (err) { next(err); }
}

async function updateSettings(req, res, next) {
  try {
    const data = updateSettingsSchema.parse(req.body);
    const { workspaceId } = req.params;
    const settings = await workspaceService.updateSettings({
      workspaceId,
      data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });
    success(res, { settings });
  } catch (err) { next(err); }
}

async function announceToWorkspace(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { title, body, target_role } = announceSchema.parse(req.body);
    const result = await workspaceService.announceToWorkspace({
      workspaceId, title, body, target_role, actorCtx: audit.fromReq(req),
    });
    success(res, result);
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
