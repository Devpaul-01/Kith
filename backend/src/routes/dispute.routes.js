// src/routes/dispute.routes.js
//
// Workspace-level dispute management. NOT nested under /containers — a
// dispute is looked up/listed/resolved by its own id, not scoped through
// a container path. Mounted at /v1/workspaces/:workspaceId/disputes.
const router = require('express').Router({ mergeParams: true });
const dCtrl = require('../controllers/dispute.controller');
const { requireAdmin } = require('../middleware/role');

router.get('/',                    requireAdmin, dCtrl.listDisputes);
router.get('/:disputeId',                        dCtrl.getDispute);
router.post('/:disputeId/note',                  dCtrl.addDisputeNote);
router.post('/:disputeId/resolve', requireAdmin, dCtrl.resolveDispute);

module.exports = router;
