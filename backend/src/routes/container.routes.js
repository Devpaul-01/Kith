// src/routes/container.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/containers by workspace.routes.js.
const router = require('express').Router({ mergeParams: true });
const cCtrl = require('../controllers/container.controller');
const pCtrl = require('../controllers/participant.controller');
const { requireAdmin } = require('../middleware/role');
const { uploadLimiter } = require('../middleware/rateLimiter');

router.get('/',                                    cCtrl.listContainers);
router.post('/',                                   requireAdmin, cCtrl.createContainer);
router.get('/:containerId',                         cCtrl.getContainer);
router.patch('/:containerId',                       requireAdmin, cCtrl.updateContainer);
router.delete('/:containerId',                      requireAdmin, cCtrl.deleteContainer);

router.post('/:containerId/restore',                requireAdmin, cCtrl.restoreContainer);

router.post('/:containerId/complete',               requireAdmin, cCtrl.completeContainer);
router.post('/:containerId/convert-to-recurring',   requireAdmin, cCtrl.convertToRecurring);
router.post('/:containerId/archive',                requireAdmin, cCtrl.archiveContainer);
router.post('/:containerId/generate-public-link',   requireAdmin, cCtrl.generatePublicLink);
router.get('/:containerId/summary',                 cCtrl.getSummary);

router.get('/:containerId/cycles',                  requireAdmin, cCtrl.listCycles);
router.post('/:containerId/cycles/:cycleId/override', requireAdmin, pCtrl.overrideCycle);

router.post(
  '/:containerId/outcome-files/upload-url',
  requireAdmin, uploadLimiter, cCtrl.generateOutcomeFileUploadUrl
);
router.post(
  '/:containerId/cover-photos/upload-url',
  requireAdmin, uploadLimiter, cCtrl.generateCoverPhotoUploadUrl
);

router.use('/:containerId/participants', require('./participant.routes'));
router.use('/:containerId/ledger',       require('./ledger.routes'));
router.use('/:containerId/tasks',        require('./task.routes'));

module.exports = router;
