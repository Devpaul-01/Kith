// src/routes/milestone.routes.js
//
// Timeline + milestones. Mounted at the workspace router's root ('/') —
// these paths don't share a common resource prefix the way /members or
// /groups do.
const router = require('express').Router({ mergeParams: true });
const msCtrl = require('../controllers/milestone.controller');
const { requireAdmin } = require('../middleware/role');
const { uploadLimiter } = require('../middleware/rateLimiter');

router.get('/timeline',                                            msCtrl.getTimeline);
router.post('/milestones',                     requireAdmin,       msCtrl.createMilestone);
// Single milestone fetch — must be declared before PATCH/DELETE to avoid route ambiguity
router.get('/milestones/:milestoneId',                             msCtrl.getMilestone);
router.patch('/milestones/:milestoneId',       requireAdmin,       msCtrl.updateMilestone);
router.delete('/milestones/:milestoneId',      requireAdmin,       msCtrl.deleteMilestone);
router.post('/milestones/:milestoneId/photos/upload-url', requireAdmin, uploadLimiter, msCtrl.getMilestonePhotoUploadUrl);
router.post('/milestones/:milestoneId/photos/confirm',    requireAdmin, msCtrl.confirmMilestonePhoto);

module.exports = router;
