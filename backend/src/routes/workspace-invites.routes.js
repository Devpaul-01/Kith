// src/routes/workspace-invites.routes.js
//
// Workspace-scoped invite management (create/list/revoke). Distinct from
// routes/invite.routes.js, which is the legacy top-level
// /v1/invites/:token/accept endpoint.
// Mounted at /v1/workspaces/:workspaceId/invites.
const router = require('express').Router({ mergeParams: true });
const iCtrl = require('../controllers/invite.controller');
const { requireAdmin } = require('../middleware/role');

router.post('/',              requireAdmin, iCtrl.createInvite);
router.get('/',                requireAdmin, iCtrl.listInvites);
router.delete('/:inviteId',   requireAdmin, iCtrl.revokeInvite);

module.exports = router;
