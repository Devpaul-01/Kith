// src/controllers/member.controller.js
//
// Member CRUD/profile/engagement logic lives in services/member.service.js.

const { success } = require('../utils/response');
const { createMemberSchema, updateMemberSchema } = require('../validators/workspace.validator');
const audit = require('../services/audit.service');
const memberService = require('../services/member.service');

async function listMembers(req, res, next) {
  try {
    const { workspaceId }     = req.params;
    const isAdmin             = req.member.role === 'admin';
    const { search }          = req.query;
    const filterRole          = req.query['filter[role]'];
    const filterProxy         = req.query['filter[is_proxy]'];

    const result = await memberService.listMembers({
      workspaceId, isAdmin, search, filterRole, filterProxy, sortQuery: req.query,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function createMember(req, res, next) {
  try {
    const data            = createMemberSchema.parse(req.body);
    const { workspaceId } = req.params;
    const member = await memberService.createMember({ workspaceId, data, actorCtx: audit.fromReq(req) });
    success(res, { member }, 201);
  } catch (err) { next(err); }
}

async function getMember(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const isAdmin = req.member.role === 'admin';
    const member = await memberService.getMember({ workspaceId, memberId, isAdmin });
    success(res, { member });
  } catch (err) { next(err); }
}

async function updateMember(req, res, next) {
  try {
    const data                      = updateMemberSchema.parse(req.body);
    const { workspaceId, memberId } = req.params;
    const isAdmin                   = req.member.role === 'admin';

    const member = await memberService.updateMember({
      workspaceId, memberId, data, isAdmin, actorMemberId: req.member.id,
    });

    success(res, { member });
  } catch (err) { next(err); }
}

async function deleteMember(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const { force }                 = req.query;

    await memberService.deleteMember({
      workspaceId, memberId,
      callerMemberId: req.member.id,
      force,
      workspaceName: req.workspace?.name,
      actorCtx: audit.fromReq(req),
    });

    success(res, { message: 'Member removed.' });
  } catch (err) { next(err); }
}

async function getProfileHistory(req, res, next) {
  try {
    const { memberId } = req.params;
    const history = await memberService.getProfileHistory({ memberId });
    success(res, { history });
  } catch (err) { next(err); }
}

async function getContributionSummary(req, res, next) {
  try {
    const { workspaceId, memberId } = req.params;
    const result = await memberService.getContributionSummary({ workspaceId, memberId });
    success(res, result);
  } catch (err) { next(err); }
}

async function getMemberEngagement(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const members = await memberService.getMemberEngagement({ workspaceId });
    success(res, { members });
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
