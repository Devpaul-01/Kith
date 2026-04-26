// src/routes/auth.routes.js
const router = require('express').Router();
const ctrl   = require('../controllers/auth.controller');
const { requireAuth, loadDbUser } = require('../middleware/auth');
const { authLimiter, uploadLimiter } = require('../middleware/rateLimiter');

// ── Public (no JWT required) ──────────────────────────────────────

// Email/password registration — creates Supabase user + sends verification email
router.post('/signup', authLimiter, ctrl.signup);

// Email/password login — returns access_token + refresh_token
router.post('/login', authLimiter, ctrl.login);

// Refresh access token using a refresh token
router.post('/refresh', authLimiter, ctrl.refreshToken);

// Send password-reset email (always returns success to prevent enumeration)
router.post('/forgot-password', authLimiter, ctrl.forgotPassword);

// Get Google OAuth redirect URL — frontend opens this URL
router.get('/google/url', ctrl.getGoogleAuthUrl);

// Issue 5.5: Exchange Google OAuth code for a session after redirect
router.post('/google/callback', authLimiter, ctrl.googleCallback);

// Issue 5.4: Exchange Supabase OTP token (from email verification link) for a session
router.post('/verify-email', authLimiter, ctrl.verifyEmail);

// ── Authenticated ─────────────────────────────────────────────────

// Logout — invalidates the current session
router.post('/logout', requireAuth, ctrl.logout);

// Issue 5.6: Logout from all devices — revokes all sessions for the user
router.post('/logout-all-devices', requireAuth, ctrl.logoutAllDevices);

// Reset password — requires the short-lived recovery JWT from the reset email
router.post('/reset-password', requireAuth, ctrl.resetPassword);

// Complete / upsert user profile (call after signup or Google OAuth)
// Idempotent — safe to call multiple times
router.post('/register', requireAuth, ctrl.register);

// Get current user + workspace memberships
router.get('/me', requireAuth, loadDbUser, ctrl.getMe);

// Update profile fields (bio, name, country, timezone, avatar_url)
router.patch('/profile', requireAuth, loadDbUser, ctrl.updateProfile);

// Get signed upload URL for profile avatar, then call PATCH /profile with avatar_url
router.post('/avatar/upload-url', requireAuth, loadDbUser, uploadLimiter, ctrl.getAvatarUploadUrl);

// Replace contact methods (phone, WhatsApp, social, etc.)
router.patch('/contacts', requireAuth, loadDbUser, ctrl.updateContacts);

// Individual contact management
router.get('/contacts',                  requireAuth, loadDbUser, ctrl.getUserContacts);
router.post('/contacts',                 requireAuth, loadDbUser, ctrl.upsertContact);
router.delete('/contacts/:contactId',    requireAuth, loadDbUser, ctrl.deleteContact);

// Register / update FCM push notification token
router.post('/push-token', requireAuth, loadDbUser, ctrl.registerPushToken);

// Toggle push notifications and email digest on/off
router.patch('/notification-preferences', requireAuth, loadDbUser, ctrl.updateNotificationPrefs);

// Issue 21: GDPR data export — queues an async job; result emailed to user
router.post('/data-export', requireAuth, loadDbUser, ctrl.requestDataExport);

module.exports = router;
