// src/controllers/ledger.controller.js
//
// Service-layer refactor: ledger entry lifecycle, idempotency, proofs,
// corrections, and export logic now live in services/ledger.service.js.
// Clients should still send X-Idempotency-Key: <uuid-per-submission> on
// POST /ledger to guarantee exactly-once recording (unchanged contract).

const { success, paginate } = require('../utils/response');
const { createLedgerEntrySchema, updateLedgerEntrySchema, uploadFileSchema, confirmProofSchema, addCorrectionSchema } = require('../validators/ledger.validator');
const audit = require('../services/audit.service');
const { getPagination } = require('../utils/pagination');
const ledgerService = require('../services/ledger.service');

async function listEntries(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;
    const isAdmin    = req.member.role === 'admin';
    const callerId   = req.member.id;
    const { page, perPage, offset } = getPagination(req.query);

    const { entries, count } = await ledgerService.listEntries({
      workspaceId, containerId, isAdmin, callerId, query: req.query, page, perPage, offset,
    });

    paginate(res, { entries }, count, page, perPage);
  } catch (err) { next(err); }
}

async function getEntry(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const entry = await ledgerService.getEntry({
      containerId, entryId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });
    success(res, { entry });
  } catch (err) { next(err); }
}

async function createEntry(req, res, next) {
  try {
    const data = createLedgerEntrySchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const { entry, idempotent } = await ledgerService.createEntry({
      workspaceId, containerId, data,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      force: req.query.force === 'true',
      idempotencyKey: req.headers['x-idempotency-key'] || null,
      actorDisplayName: req.member.displayName,
      actorCtx: audit.fromReq(req),
    });

    success(res, { entry, ...(idempotent ? { idempotent: true } : {}) }, idempotent ? 200 : 201);
  } catch (err) { next(err); }
}

async function updateEntry(req, res, next) {
  try {
    const data                     = updateLedgerEntrySchema.parse(req.body);
    const { containerId, entryId } = req.params;

    const entry = await ledgerService.updateEntry({
      containerId, entryId, data,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, { entry });
  } catch (err) { next(err); }
}

async function deleteEntry(req, res, next) {
  try {
    const { containerId, entryId } = req.params;

    await ledgerService.deleteEntry({
      containerId, entryId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { message: 'Ledger entry deleted.' });
  } catch (err) { next(err); }
}

async function getLedgerSummary(req, res, next) {
  try {
    const { workspaceId, containerId } = req.params;

    const summary = await ledgerService.getLedgerSummary({
      workspaceId, containerId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, { summary });
  } catch (err) { next(err); }
}

async function getUploadProofUrl(req, res, next) {
  try {
    const data                                  = uploadFileSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const result = await ledgerService.getUploadProofUrl({
      workspaceId, containerId, entryId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function confirmProof(req, res, next) {
  try {
    const data                                  = confirmProofSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const entry = await ledgerService.confirmProof({
      workspaceId, containerId, entryId,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
      filePayload: data,
      actorDisplayName: req.member.displayName,
    });

    success(res, { entry });
  } catch (err) { next(err); }
}

async function confirmEntry(req, res, next) {
  try {
    const { workspaceId, containerId, entryId } = req.params;

    const entry = await ledgerService.confirmEntry({
      workspaceId, containerId, entryId,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { entry });
  } catch (err) { next(err); }
}

async function addCorrection(req, res, next) {
  try {
    const data                                  = addCorrectionSchema.parse(req.body);
    const { workspaceId, containerId, entryId } = req.params;

    const correction = await ledgerService.addCorrection({
      workspaceId, containerId, entryId, data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { correction_entry: correction }, 201);
  } catch (err) { next(err); }
}

async function getProofUrl(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const fileIndex = parseInt(req.query.file_index) || 0;

    const result = await ledgerService.getProofUrl({
      containerId, entryId, fileIndex,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function deleteProof(req, res, next) {
  try {
    const { containerId, entryId } = req.params;
    const proofIndex = parseInt(req.params.proofIndex, 10);

    const entry = await ledgerService.deleteProof({
      containerId, entryId, proofIndex,
      isAdmin: req.member.role === 'admin',
      callerId: req.member.id,
    });

    success(res, { entry });
  } catch (err) { next(err); }
}

async function exportLedger(req, res, next) {
  try {
    const { workspaceId }            = req.params;
    const { container_id, from, to } = req.query;

    const csv = await ledgerService.exportLedger({ workspaceId, containerId: container_id, from, to });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

module.exports = {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  getLedgerSummary,
  getUploadProofUrl,
  confirmProof,
  confirmEntry,
  addCorrection,
  getProofUrl,
  deleteProof,
  exportLedger,
};
