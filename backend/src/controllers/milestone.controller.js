// src/controllers/milestone.controller.js
//
// Service-layer refactor: timeline/milestone logic now lives in
// services/milestone.service.js.

const { noContent, success } = require('../utils/response');
const { createMilestoneSchema, updateMilestoneSchema, uploadFileSchema, confirmProofSchema } = require('../validators/ledger.validator');
const milestoneService = require('../services/milestone.service');

async function getTimeline(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const result = await milestoneService.getTimeline({
      workspaceId,
      limit: req.query.limit,
      before: req.query.before,
      beforeContainer: req.query.before_container,
      beforeMilestone: req.query.before_milestone,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function createMilestone(req, res, next) {
  try {
    const data            = createMilestoneSchema.parse(req.body);
    const { workspaceId } = req.params;
    const milestone = await milestoneService.createMilestone({
      workspaceId,
      title: data.title,
      milestone_date: data.milestone_date,
      description: data.description,
      milestone_type: data.milestone_type,
      actorMemberId: req.member.id,
    });
    success(res, { milestone }, 201);
  } catch (err) { next(err); }
}

async function getMilestone(req, res, next) {
  try {
    const { workspaceId, milestoneId } = req.params;
    const milestone = await milestoneService.getMilestone({ workspaceId, milestoneId });
    success(res, { milestone });
  } catch (err) { next(err); }
}

async function updateMilestone(req, res, next) {
  try {
    const data                         = updateMilestoneSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;
    const milestone = await milestoneService.updateMilestone({ workspaceId, milestoneId, data });
    success(res, { milestone });
  } catch (err) { next(err); }
}

async function deleteMilestone(req, res, next) {
  try {
    const { workspaceId, milestoneId } = req.params;
    await milestoneService.deleteMilestone({ workspaceId, milestoneId });
    noContent(res);
  } catch (err) { next(err); }
}

async function getMilestonePhotoUploadUrl(req, res, next) {
  try {
    const data                         = uploadFileSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;
    const result = await milestoneService.getMilestonePhotoUploadUrl({
      workspaceId, milestoneId,
      filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function confirmMilestonePhoto(req, res, next) {
  try {
    const data                         = confirmProofSchema.parse(req.body);
    const { workspaceId, milestoneId } = req.params;
    const milestone = await milestoneService.confirmMilestonePhoto({
      workspaceId, milestoneId, filePayload: data, actorMemberId: req.member.id,
    });
    success(res, { milestone });
  } catch (err) { next(err); }
}

module.exports = {
  getTimeline,
  createMilestone,
  getMilestone,
  updateMilestone,
  deleteMilestone,
  getMilestonePhotoUploadUrl,
  confirmMilestonePhoto,
};
