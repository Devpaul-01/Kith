// src/routes/container.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/containers by workspace.routes.js.
const router = require('express').Router({ mergeParams: true });
const cCtrl = require('../controllers/container.controller');
const pCtrl = require('../controllers/participant.controller');
const { requireAdmin } = require('../middleware/role');
const { uploadLimiter } = require('../middleware/rateLimiter');
const { NotFoundError } = require('../utils/errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A non-UUID :containerId can never match a row; without this guard it
// reaches Postgres as an invalid uuid literal (22P02) and surfaces as a
// 500 instead of a 404 (e.g. GET /containers/x/ledger/export).
router.param('containerId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return next(new NotFoundError('Container not found'));
  next();
});

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
