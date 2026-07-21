// src/controllers/invite.controller.js
//
// Invite lifecycle logic lives in services/invite.service.js.

const { success } = require('../utils/response');
const audit = require('../services/audit.service');
const inviteService = require('../services/invite.service');

async function createInvite(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const result = await inviteService.createInvite({
      workspaceId,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });
    success(res, result, 201);
  } catch (err) { next(err); }
}

async function previewInvite(req, res, next) {
  try {
    const { token } = req.params;
    const result = await inviteService.previewInvite({ token });
    success(res, result);
  } catch (err) { next(err); }
}

async function acceptInvite(req, res, next) {
  try {
    const { token } = req.params;
    const result = await inviteService.acceptInvite({
      token,
      userId: req.user.id,
      actorCtx: audit.fromReq(req),
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function listInvites(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const invites = await inviteService.listInvites({ workspaceId });
    success(res, { invites });
  } catch (err) { next(err); }
}

async function revokeInvite(req, res, next) {
  try {
    const { workspaceId, inviteId } = req.params;
    await inviteService.revokeInvite({ workspaceId, inviteId });
    success(res, { message: 'Invite revoked.' });
  } catch (err) { next(err); }
}

module.exports = { createInvite, previewInvite, acceptInvite, listInvites, revokeInvite };
