// src/controllers/dispute.controller.js
//
// Dispute lifecycle logic lives in services/dispute.service.js.

const { success, paginate } = require('../utils/response');
const { createDisputeSchema, addDisputeNoteSchema, resolveDisputeSchema } = require('../validators/ledger.validator');
const audit = require('../services/audit.service');
const { getPagination } = require('../utils/pagination');
const disputeService = require('../services/dispute.service');

async function listDisputes(req, res, next) {
  try {
    const { workspaceId } = req.params;
    const { page, perPage, offset } = getPagination(req.query);

    const { disputes, count } = await disputeService.listDisputes({
      workspaceId, statusFilter: req.query.status, page, perPage, offset,
    });

    paginate(res, { disputes }, count, page, perPage);
  } catch (err) { next(err); }
}

async function getDispute(req, res, next) {
  try {
    const { workspaceId, disputeId } = req.params;
    const result = await disputeService.getDispute({
      workspaceId, disputeId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });
    success(res, result);
  } catch (err) { next(err); }
}

async function raiseDispute(req, res, next) {
  try {
    const data                                  = createDisputeSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const result = await disputeService.raiseDispute({
      workspaceId, containerId, entryId,
      reason: data.reason,
      callerId: req.member.id,
      isAdmin: req.member.role === 'admin',
      actorDisplayName: req.member.displayName,
      actorCtx: audit.fromReq(req),
    });

    success(res, result, 201);
  } catch (err) { next(err); }
}

async function addDisputeNote(req, res, next) {
  try {
    const data                       = addDisputeNoteSchema.parse(req.body);
    const { workspaceId, disputeId } = req.params;

    const dispute = await disputeService.addDisputeNote({
      workspaceId, disputeId,
      note: data.note,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, { dispute });
  } catch (err) { next(err); }
}

async function resolveDispute(req, res, next) {
  try {
    const data                       = resolveDisputeSchema.parse(req.body);
    const { workspaceId, disputeId } = req.params;

    const dispute = await disputeService.resolveDispute({
      workspaceId, disputeId,
      resolutionNote: data.resolution_note,
      resolvedByMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { dispute });
  } catch (err) { next(err); }
}

module.exports = { listDisputes, getDispute, raiseDispute, addDisputeNote, resolveDispute };
