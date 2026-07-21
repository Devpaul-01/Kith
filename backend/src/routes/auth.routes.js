// src/routes/auth.routes.js
const router = require('express').Router();
const ctrl   = require('../controllers/auth.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const { authLimiter, uploadLimiter } = require('../middleware/rateLimiter');

// ── Public (no JWT required) ──────────────────────────────────────

router.post('/signup', authLimiter, ctrl.signup);
router.post('/login', authLimiter, ctrl.login);
router.post('/refresh', authLimiter, ctrl.refreshToken);
router.post('/forgot-password', authLimiter, ctrl.forgotPassword);
router.get('/google/url', ctrl.getGoogleAuthUrl);
router.post('/google/callback', authLimiter, ctrl.googleCallback);
router.post('/verify-email', authLimiter, ctrl.verifyEmail);

// ── Authenticated ─────────────────────────────────────────────────

router.post('/logout', requireAuth, ctrl.logout);
router.post('/logout-all-devices', requireAuth, ctrl.logoutAllDevices);
router.post('/reset-password', requireAuth, ctrl.resetPassword);
router.post('/change-password', requireAuth, ctrl.changePassword);
router.post('/register', requireAuth, ctrl.register);
router.get('/me', requireAuth, loadDbUser, ctrl.getMe);
router.patch('/profile', requireAuth, loadDbUser, ctrl.updateProfile);
router.post('/avatar/upload-url', requireAuth, loadDbUser, uploadLimiter, ctrl.getAvatarUploadUrl);
router.patch('/contacts', requireAuth, loadDbUser, ctrl.updateContacts);
router.get('/contacts',                  requireAuth, loadDbUser, ctrl.getUserContacts);
router.post('/contacts',                 requireAuth, loadDbUser, ctrl.upsertContact);
router.delete('/contacts/:contactId',    requireAuth, loadDbUser, ctrl.deleteContact);
router.post('/push-token', requireAuth, loadDbUser, ctrl.registerPushToken);
router.patch('/notification-preferences', requireAuth, loadDbUser, ctrl.updateNotificationPrefs);
router.post('/data-export', requireAuth, loadDbUser, ctrl.requestDataExport);

module.exports = router;
