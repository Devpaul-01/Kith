// src/controllers/container.controller.js
//
// Container CRUD/lifecycle/summary/cycles/public-view logic lives in
// services/container.service.js.

const { success, paginate } = require('../utils/response');
const { createContainerSchema, updateContainerSchema, completeContainerSchema, convertToRecurringSchema } = require('../validators/workspace.validator');
const { uploadFileSchema }    = require('../validators/ledger.validator');
const audit = require('../services/audit.service');
const logger = require('../utils/logger');
const { getPagination } = require('../utils/pagination');
const containerService = require('../services/container.service');

async function listContainers(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const isAdmin = req.member?.role === 'admin';
    const result = await containerService.listContainers({
      workspaceId,
      typeFilter: req.query['type'],
      statusFilter: req.query['status'],
      sortQuery: req.query,
      // Only admins may request soft-deleted containers (e.g. to restore one);
      // the flag is silently ignored for non-admins, who always get the
      // normal non-deleted view regardless of what they pass.
      includeDeleted: isAdmin && req.query['include_deleted'] === 'true',
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function createContainer(req, res, next) {
  try {
    const result = createContainerSchema.safeParse(req.body);

    if (!result.success) {
      logger.warn('createContainerSchema validation failed', {
        workspaceId: req.params.workspaceId,
        issues: result.error.issues,
      });
      // Hand off to errorHandler so the response uses the same
      // VALIDATION_FAILED shape (code/message/field/details) as every
      // other validated route.
      return next(result.error);
    }

    const { workspaceId } = req.params;
    const container = await containerService.createContainer({
      workspaceId,
      data: result.data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { container }, 201);
  } catch (err) { next(err); }
}

async function getContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const result = await containerService.getContainer({ workspaceId, containerId, callerMemberId: req.member.id });
    success(res, result);
  } catch (err) { next(err); }
}

async function updateContainer(req, res, next) {
  try {
    const data                         = updateContainerSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const container = await containerService.updateContainer({
      workspaceId, containerId, data, actorCtx: audit.fromReq(req),
    });

    success(res, { container });
  } catch (err) { next(err); }
}

async function completeContainer(req, res, next) {
  try {
    const data                         = completeContainerSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const container = await containerService.completeContainer({
      workspaceId, containerId, data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { container });
  } catch (err) { next(err); }
}

async function convertToRecurring(req, res, next) {
  try {
    const data                         = convertToRecurringSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const result = await containerService.convertToRecurring({
      workspaceId, containerId, data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, result, 201);
  } catch (err) { next(err); }
}

async function archiveContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const container = await containerService.archiveContainer({ workspaceId, containerId, actorCtx: audit.fromReq(req) });
    success(res, { container });
  } catch (err) { next(err); }
}

async function generatePublicLink(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const result = await containerService.generatePublicLink({ workspaceId, containerId });
    success(res, result);
  } catch (err) { next(err); }
}

async function deleteContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    await containerService.deleteContainer({ workspaceId, containerId, actorCtx: audit.fromReq(req) });
    success(res, { message: 'Container deleted.' });
  } catch (err) { next(err); }
}

async function restoreContainer(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const container = await containerService.restoreContainer({ workspaceId, containerId, actorCtx: audit.fromReq(req) });
    success(res, { container });
  } catch (err) { next(err); }
}

async function getSummary(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const result = await containerService.getSummary({
      workspaceId, containerId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function listCycles(req, res, next) {
  try {
    const { containerId } = req.params;
    const { page, perPage, offset } = getPagination(req.query);

    const { cycles, count } = await containerService.listCycles({
      containerId, statusFilter: req.query['status'], page, perPage, offset,
    });

    paginate(res, { cycles }, count, page, perPage);
  } catch (err) { next(err); }
}

async function generateOutcomeFileUploadUrl(req, res, next) {
  try {
    const data                         = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await containerService.generateOutcomeFileUploadUrl({
      workspaceId, containerId, filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function generateCoverPhotoUploadUrl(req, res, next) {
  try {
    const data                         = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;
    const result = await containerService.generateCoverPhotoUploadUrl({
      workspaceId, containerId, filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function getPublicContainer(req, res, next) {
  try {
    const { publicToken } = req.params;
    const response = await containerService.getPublicContainer({ publicToken });
    success(res, response);
  } catch (err) { next(err); }
}

module.exports = {
  listContainers,
  createContainer,
  getContainer,
  updateContainer,
  completeContainer,
  convertToRecurring,
  archiveContainer,
  generatePublicLink,
  deleteContainer,
  restoreContainer,
  getSummary,
  listCycles,
  generateOutcomeFileUploadUrl,
  generateCoverPhotoUploadUrl,
  getPublicContainer,
};
