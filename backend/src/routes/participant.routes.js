// src/routes/participant.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/containers/:containerId/participants
// by container.routes.js. mergeParams:true so :containerId is available here.
const router = require('express').Router({ mergeParams: true });
const pCtrl = require('../controllers/participant.controller');
const { requireAdmin } = require('../middleware/role');

router.get('/',                                requireAdmin, pCtrl.listParticipants);
router.post('/',                               requireAdmin, pCtrl.addParticipants);
router.post('/from-group',                     requireAdmin, pCtrl.addParticipantsFromGroup);
router.patch('/:participantId',                requireAdmin, pCtrl.updateParticipant);
router.delete('/:participantId',               requireAdmin, pCtrl.removeParticipant);
router.post('/:participantId/set-target',      requireAdmin, pCtrl.setTarget);
router.get('/:participantId/target-history',   requireAdmin, pCtrl.getTargetHistory);
router.get('/:participantId/cycle-targets',    requireAdmin, pCtrl.getCycleTargets);

module.exports = router;
