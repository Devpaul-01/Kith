// src/routes/ledger.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/containers/:containerId/ledger
// by container.routes.js. mergeParams:true so :containerId is available.
//
// NOTE: GET /v1/workspaces/:workspaceId/ledger/export (a workspace-wide
// export, NOT scoped to one container) is intentionally NOT here — it's
// mounted directly on the workspace root router (see routes/workspace.routes.js)
// since it was never nested under /containers/:containerId in the first
// place.
//
// Static sub-paths (/summary) are still declared before the dynamic
// /:entryId route below — that ordering constraint is now scoped to just
// this one small file instead of competing with ~70 sibling routes across
// the old monolithic workspace.routes.js (audit finding 3.5/7.1).
const router = require('express').Router({ mergeParams: true });
const lCtrl = require('../controllers/ledger.controller');
const dCtrl = require('../controllers/dispute.controller');
const { requireAdmin } = require('../middleware/role');
const { uploadLimiter } = require('../middleware/rateLimiter');

router.get('/',                                lCtrl.listEntries);
router.post('/',                               lCtrl.createEntry);

// Lightweight aggregate — must stay before /:entryId or 'summary' gets captured as an entryId
router.get('/summary',                         lCtrl.getLedgerSummary);

router.get('/:entryId',                        lCtrl.getEntry);
router.patch('/:entryId',                      lCtrl.updateEntry);
router.delete('/:entryId',                     lCtrl.deleteEntry);
router.delete('/:entryId/proof/:proofIndex',   lCtrl.deleteProof);
router.post('/:entryId/upload-proof',          uploadLimiter, lCtrl.getUploadProofUrl);
router.post('/:entryId/confirm-proof',         lCtrl.confirmProof);
router.post('/:entryId/confirm',               requireAdmin, lCtrl.confirmEntry);
router.post('/:entryId/dispute',               dCtrl.raiseDispute);
router.post('/:entryId/add-correction',        requireAdmin, lCtrl.addCorrection);
router.get('/:entryId/proof-url',              lCtrl.getProofUrl);

module.exports = router;
