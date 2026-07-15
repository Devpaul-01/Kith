// src/routes/workspace.routes.js
const router = require('express').Router({ mergeParams: true });

const wCtrl  = require('../controllers/workspace.controller');
const mCtrl  = require('../controllers/member.controller');
const iCtrl  = require('../controllers/invite.controller');
const gCtrl  = require('../controllers/group.controller');
const cCtrl  = require('../controllers/container.controller');
const pCtrl  = require('../controllers/participant.controller');
const lCtrl  = require('../controllers/ledger.controller');
const dCtrl  = require('../controllers/dispute.controller');
const tCtrl  = require('../controllers/task.controller');
const msCtrl = require('../controllers/milestone.controller');

const { requireAuth, loadDbUser }   = require('../middleware/auth');
const { requireMembership }         = require('../middleware/workspace');
// requireSelfOrAdmin: allows the resource owner OR any admin (used for member updates below)
const { requireAdmin, requireSelfOrAdmin } = require('../middleware/role');
const { uploadLimiter }             = require('../middleware/rateLimiter');

// Apply auth + active-membership check to EVERY route in this router
router.use(requireAuth, loadDbUser, requireMembership);

// ── Workspace ──────────────────────────────────────────────────────
router.get('/',           wCtrl.getWorkspace);
router.patch('/',         requireAdmin, wCtrl.updateWorkspace);
router.delete('/',        requireAdmin, wCtrl.deleteWorkspace);
router.get('/dashboard',  wCtrl.getDashboard);
router.get('/settings',   requireAdmin, wCtrl.getSettings);
router.patch('/settings', requireAdmin, wCtrl.updateSettings);

// Cross-entity search across members + containers
router.get('/search', wCtrl.searchWorkspace);

// Admin broadcast — send admin_announcement to all (or role-filtered) members
router.post('/announce',  requireAdmin, wCtrl.announceToWorkspace);

// Paginated, filterable audit log exposed to admins
router.get('/audit-log',  requireAdmin, wCtrl.getAuditLog);
router.get('/audit-log/export', requireAdmin, wCtrl.exportAuditLog);

// Overdue contribution summary across all active containers
router.get('/overdue-summary', requireAdmin, wCtrl.getOverdueSummary);

// Workspace avatar upload
router.post('/avatar-upload-url', requireAdmin, uploadLimiter, wCtrl.getAvatarUploadUrl);

// ── Members ────────────────────────────────────────────────────────
router.get('/members',                         mCtrl.listMembers);
router.post('/members',                        requireAdmin, mCtrl.createMember);
router.get('/members/engagement',              requireAdmin, mCtrl.getMemberEngagement);
router.get('/members/:memberId',               mCtrl.getMember);
// Authorization enforced here (route level) via requireSelfOrAdmin, not duplicated in the controller
router.patch('/members/:memberId',             requireSelfOrAdmin(), mCtrl.updateMember);
router.delete('/members/:memberId',            requireAdmin, mCtrl.deleteMember);
router.get('/members/:memberId/profile-history',      requireAdmin, mCtrl.getProfileHistory);
router.get('/members/:memberId/contribution-summary', mCtrl.getContributionSummary);

// ── Invites ────────────────────────────────────────────────────────
router.post('/invites',              requireAdmin, iCtrl.createInvite);
router.get('/invites',               requireAdmin, iCtrl.listInvites);
router.delete('/invites/:inviteId',  requireAdmin, iCtrl.revokeInvite);

// ── Groups ─────────────────────────────────────────────────────────
router.get('/groups',                               gCtrl.listGroups);
router.post('/groups',                              requireAdmin, gCtrl.createGroup);
router.get('/groups/:groupId',                      requireAdmin, gCtrl.getGroup);
router.patch('/groups/:groupId',                    requireAdmin, gCtrl.updateGroup);
router.delete('/groups/:groupId',                   requireAdmin, gCtrl.deleteGroup);
router.post('/groups/:groupId/members',             requireAdmin, gCtrl.addGroupMembers);
router.delete('/groups/:groupId/members/:memberId', requireAdmin, gCtrl.removeGroupMember);

// ── Containers ─────────────────────────────────────────────────────
router.get('/containers',                                    cCtrl.listContainers);
router.post('/containers',                                   requireAdmin, cCtrl.createContainer);
router.get('/containers/:containerId',                       cCtrl.getContainer);
router.patch('/containers/:containerId',                     requireAdmin, cCtrl.updateContainer);
router.delete('/containers/:containerId',                    requireAdmin, cCtrl.deleteContainer);

// Restore a soft-deleted container (admin only)
router.post('/containers/:containerId/restore',              requireAdmin, cCtrl.restoreContainer);

router.post('/containers/:containerId/complete',             requireAdmin, cCtrl.completeContainer);
router.post('/containers/:containerId/convert-to-recurring', requireAdmin, cCtrl.convertToRecurring);
router.post('/containers/:containerId/archive',              requireAdmin, cCtrl.archiveContainer);
router.post('/containers/:containerId/generate-public-link', requireAdmin, cCtrl.generatePublicLink);
router.get('/containers/:containerId/summary',               cCtrl.getSummary);
router.get('/containers/:containerId/cycles',                requireAdmin, cCtrl.listCycles);
router.post(
  '/containers/:containerId/outcome-files/upload-url',
  requireAdmin, uploadLimiter, cCtrl.generateOutcomeFileUploadUrl
);
router.post(
  '/containers/:containerId/cover-photos/upload-url',
  requireAdmin, uploadLimiter, cCtrl.generateCoverPhotoUploadUrl
);

// ── Participants ───────────────────────────────────────────────────
router.get('/containers/:containerId/participants',                                requireAdmin, pCtrl.listParticipants);
router.post('/containers/:containerId/participants',                               requireAdmin, pCtrl.addParticipants);
router.post('/containers/:containerId/participants/from-group',                   requireAdmin, pCtrl.addParticipantsFromGroup);
router.patch('/containers/:containerId/participants/:participantId',              requireAdmin, pCtrl.updateParticipant);
router.delete('/containers/:containerId/participants/:participantId',             requireAdmin, pCtrl.removeParticipant);
router.post('/containers/:containerId/participants/:participantId/set-target',    requireAdmin, pCtrl.setTarget);
router.get('/containers/:containerId/participants/:participantId/target-history', requireAdmin, pCtrl.getTargetHistory);
router.get('/containers/:containerId/participants/:participantId/cycle-targets',  requireAdmin, pCtrl.getCycleTargets);

// ── Cycle overrides ────────────────────────────────────────────────
router.post('/containers/:containerId/cycles/:cycleId/override', requireAdmin, pCtrl.overrideCycle);

// ── Ledger ─────────────────────────────────────────────────────────
// NOTE: static sub-paths (/summary) MUST be declared BEFORE /:entryId to avoid
// "summary" being captured as an entryId parameter.

router.get('/containers/:containerId/ledger',                            lCtrl.listEntries);
router.post('/containers/:containerId/ledger',                           lCtrl.createEntry);

// Lightweight aggregate — must be declared BEFORE /:entryId or 'summary' gets captured as an entryId
router.get('/containers/:containerId/ledger/summary',                    lCtrl.getLedgerSummary);

// Single-entry fetch
router.get('/containers/:containerId/ledger/:entryId',                   lCtrl.getEntry);

router.patch('/containers/:containerId/ledger/:entryId',                 lCtrl.updateEntry);

// Delete a pending or non-confirmed entry
router.delete('/containers/:containerId/ledger/:entryId',                lCtrl.deleteEntry);

// Remove a proof file by index
router.delete('/containers/:containerId/ledger/:entryId/proof/:proofIndex', lCtrl.deleteProof);

router.post('/containers/:containerId/ledger/:entryId/upload-proof',     uploadLimiter, lCtrl.getUploadProofUrl);
router.post('/containers/:containerId/ledger/:entryId/confirm-proof',    lCtrl.confirmProof);
router.post('/containers/:containerId/ledger/:entryId/confirm',          requireAdmin, lCtrl.confirmEntry);
router.post('/containers/:containerId/ledger/:entryId/dispute',          dCtrl.raiseDispute);
router.post('/containers/:containerId/ledger/:entryId/add-correction',   requireAdmin, lCtrl.addCorrection);
router.get('/containers/:containerId/ledger/:entryId/proof-url',         lCtrl.getProofUrl);
router.get('/ledger/export',                                             requireAdmin, lCtrl.exportLedger);

// ── Disputes ───────────────────────────────────────────────────────
router.get('/disputes',                          requireAdmin, dCtrl.listDisputes);
router.get('/disputes/:disputeId',                             dCtrl.getDispute);
router.post('/disputes/:disputeId/note',                       dCtrl.addDisputeNote);
router.post('/disputes/:disputeId/resolve',      requireAdmin, dCtrl.resolveDispute);

// ── Tasks ──────────────────────────────────────────────────────────
// NOTE: static sub-paths (/export, /bulk) MUST be declared before /:taskId

router.get('/containers/:containerId/tasks',           tCtrl.listTasks);
router.post('/containers/:containerId/tasks',          requireAdmin, tCtrl.createTask);
router.post('/containers/:containerId/tasks/bulk',     requireAdmin, tCtrl.bulkCreateTasks);
router.get('/containers/:containerId/tasks/export',    tCtrl.exportTasks);

router.get('/containers/:containerId/tasks/:taskId',                  tCtrl.getTask);
router.patch('/containers/:containerId/tasks/:taskId',                tCtrl.updateTask);
router.delete('/containers/:containerId/tasks/:taskId',               requireAdmin, tCtrl.deleteTask);
router.patch('/containers/:containerId/tasks/:taskId/reassign',       requireAdmin, tCtrl.reassignTask);
// overrideTaskStatus is an admin-only hard override
router.patch('/containers/:containerId/tasks/:taskId/status',         requireAdmin, tCtrl.overrideTaskStatus);
router.post('/containers/:containerId/tasks/:taskId/confirm',         requireAdmin, tCtrl.adminConfirmTask);
router.post('/containers/:containerId/tasks/:taskId/upload-proof',    uploadLimiter, tCtrl.getTaskProofUploadUrl);
router.post('/containers/:containerId/tasks/:taskId/confirm-proof',   tCtrl.confirmTaskProof);
// Remove a task proof file by index
router.delete('/containers/:containerId/tasks/:taskId/proof/:proofIndex', tCtrl.deleteTaskProof);

// ── Timeline + Milestones ──────────────────────────────────────────
router.get('/timeline',                                               msCtrl.getTimeline);
router.post('/milestones',                     requireAdmin,          msCtrl.createMilestone);
// Single milestone fetch — must be declared before PATCH/DELETE to avoid route ambiguity
router.get('/milestones/:milestoneId',                                msCtrl.getMilestone);
router.patch('/milestones/:milestoneId',       requireAdmin,          msCtrl.updateMilestone);
router.delete('/milestones/:milestoneId',      requireAdmin,          msCtrl.deleteMilestone);
router.post('/milestones/:milestoneId/photos/upload-url', requireAdmin, uploadLimiter, msCtrl.getMilestonePhotoUploadUrl);
router.post('/milestones/:milestoneId/photos/confirm',    requireAdmin, msCtrl.confirmMilestonePhoto);

module.exports = router;
