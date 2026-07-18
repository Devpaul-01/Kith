// src/controllers/participant.controller.js
//
// Service-layer refactor: participant/target/cycle-override logic now
// lives in services/participant.service.js.

const { success } = require('../utils/response');
const { addParticipantsSchema, addParticipantsFromGroupSchema, updateParticipantSchema, setTargetSchema, cycleOverrideSchema } = require('../validators/ledger.validator');
const audit = require('../services/audit.service');
const participantService = require('../services/participant.service');

async function listParticipants(req, res, next) {
  try {
    const { containerId } = req.params;
    const participants = await participantService.listParticipants({ containerId });
    success(res, { participants });
  } catch (err) { next(err); }
}

async function addParticipants(req, res, next) {
  try {
    const payload = addParticipantsSchema.parse(req.body);
    const { workspaceId, containerId } = req.params;

    const result = await participantService.addParticipants({
      workspaceId, containerId,
      participants: payload.participants,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, result, 201);
  } catch (err) {
    next(err);
  }
}

async function addParticipantsFromGroup(req, res, next) {
  try {
    const data                          = addParticipantsFromGroupSchema.parse(req.body);
    const { workspaceId, containerId }  = req.params;

    const result = await participantService.addParticipantsFromGroup({
      workspaceId, containerId,
      groupId: data.group_id,
      moneyEnabled: data.money_enabled,
      tasksEnabled: data.tasks_enabled,
      actorMemberId: req.member.id,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function updateParticipant(req, res, next) {
  try {
    const data                          = updateParticipantSchema.parse(req.body);
    const { containerId, participantId } = req.params;

    const participant = await participantService.updateParticipant({ containerId, participantId, data });
    success(res, { participant });
  } catch (err) { next(err); }
}

async function removeParticipant(req, res, next) {
  try {
    const { containerId, participantId } = req.params;
    await participantService.removeParticipant({ containerId, participantId });
    success(res, { message: 'Participant removed.' });
  } catch (err) { next(err); }
}

async function setTarget(req, res, next) {
  try {
    const data                          = setTargetSchema.parse(req.body);
    const { containerId, participantId } = req.params;

    const result = await participantService.setTarget({
      containerId, participantId,
      amount: data.amount, currency: data.currency, due_date: data.due_date,
      actorMemberId: req.member.id,
    });

    success(res, result);
  } catch (err) { next(err); }
}

async function getTargetHistory(req, res, next) {
  try {
    const { participantId } = req.params;
    const history = await participantService.getTargetHistory({ participantId });
    success(res, { history });
  } catch (err) { next(err); }
}

async function getCycleTargets(req, res, next) {
  try {
    const { containerId, participantId } = req.params;
    const result = await participantService.getCycleTargets({ containerId, participantId });
    success(res, result);
  } catch (err) { next(err); }
}

async function overrideCycle(req, res, next) {
  try {
    const data                                    = cycleOverrideSchema.parse(req.body);
    const { workspaceId, containerId, cycleId }   = req.params;

    const override = await participantService.overrideCycle({
      workspaceId, containerId, cycleId, data,
      actorMemberId: req.member.id,
      actorCtx: audit.fromReq(req),
    });

    success(res, { override });
  } catch (err) { next(err); }
}

module.exports = { listParticipants, addParticipants, addParticipantsFromGroup, updateParticipant, removeParticipant, setTarget, getTargetHistory, getCycleTargets, overrideCycle };
