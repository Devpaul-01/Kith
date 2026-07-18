// src/routes/member.routes.js
//
// Extracted from workspace.routes.js (audit finding 3.5). Mounted at
// /v1/workspaces/:workspaceId/members by the parent workspace router —
// mergeParams:true so :workspaceId (and req.member/req.workspace set by
// requireMembership upstream) remain available here.
const router = require('express').Router({ mergeParams: true });
const mCtrl = require('../controllers/member.controller');
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/role');

router.get('/',                          mCtrl.listMembers);
router.post('/',                         requireAdmin, mCtrl.createMember);
router.get('/engagement',                requireAdmin, mCtrl.getMemberEngagement);
router.get('/:memberId',                 mCtrl.getMember);
// Authorization enforced here (route level) via requireSelfOrAdmin, not duplicated in the controller
router.patch('/:memberId',               requireSelfOrAdmin(), mCtrl.updateMember);
router.delete('/:memberId',              requireAdmin, mCtrl.deleteMember);
router.get('/:memberId/profile-history',        requireAdmin, mCtrl.getProfileHistory);
router.get('/:memberId/contribution-summary',   mCtrl.getContributionSummary);

module.exports = router;
