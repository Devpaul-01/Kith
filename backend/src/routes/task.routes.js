// src/routes/task.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/containers/:containerId/tasks by
// container.routes.js. mergeParams:true so :containerId is available.
//
// Static sub-paths (/bulk, /export) declared before /:taskId, same
// reasoning as ledger.routes.js above.
const router = require('express').Router({ mergeParams: true });
const tCtrl = require('../controllers/task.controller');
const { requireAdmin } = require('../middleware/role');
const { uploadLimiter } = require('../middleware/rateLimiter');

router.get('/',                        tCtrl.listTasks);
router.post('/',                       requireAdmin, tCtrl.createTask);
router.post('/bulk',                   requireAdmin, tCtrl.bulkCreateTasks);
router.get('/export',                  tCtrl.exportTasks);

router.get('/:taskId',                 tCtrl.getTask);
router.patch('/:taskId',               tCtrl.updateTask);
router.delete('/:taskId',              requireAdmin, tCtrl.deleteTask);
router.patch('/:taskId/reassign',      requireAdmin, tCtrl.reassignTask);
// overrideTaskStatus is an admin-only hard override
router.patch('/:taskId/status',        requireAdmin, tCtrl.overrideTaskStatus);
router.post('/:taskId/confirm',        requireAdmin, tCtrl.adminConfirmTask);
router.post('/:taskId/upload-proof',   uploadLimiter, tCtrl.getTaskProofUploadUrl);
router.post('/:taskId/confirm-proof',  tCtrl.confirmTaskProof);
router.delete('/:taskId/proof/:proofIndex', tCtrl.deleteTaskProof);

module.exports = router;
