// src/routes/group.routes.js
//
// Mounted at /v1/workspaces/:workspaceId/groups.
const router = require('express').Router({ mergeParams: true });
const gCtrl = require('../controllers/group.controller');
const { requireAdmin } = require('../middleware/role');

router.get('/',                                   gCtrl.listGroups);
router.post('/',                                  requireAdmin, gCtrl.createGroup);
router.get('/:groupId',                           requireAdmin, gCtrl.getGroup);
router.patch('/:groupId',                         requireAdmin, gCtrl.updateGroup);
router.delete('/:groupId',                        requireAdmin, gCtrl.deleteGroup);
router.post('/:groupId/members',                  requireAdmin, gCtrl.addGroupMembers);
router.delete('/:groupId/members/:memberId',      requireAdmin, gCtrl.removeGroupMember);

module.exports = router;
