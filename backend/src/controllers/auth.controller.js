// src/controllers/auth.controller.js
//
// Service-layer refactor: all Supabase Auth calls, DB reads/writes, and
// error mapping now live in services/auth.service.js. This file parses
// requests/cookies/headers, applies validator schemas, calls the
// service, and shapes HTTP responses — including setting/clearing the
// refresh_token cookie, which is kept here since cookie transport is an
// HTTP concern, not a business rule.

const { success } = require('../utils/response');
const {
  signupSchema, loginSchema, registerSchema, forgotPasswordSchema,
  resetPasswordSchema, changePasswordSchema, updateProfileSchema, contactSchema, pushTokenSchema,
  notificationPrefsSchema, refreshTokenSchema,
} = require('../validators/auth.validator');
const { uploadFileSchema } = require('../validators/ledger.validator');
const authService = require('../services/auth.service');

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   30 * 24 * 60 * 60 * 1000,
  path:     '/v1/auth/refresh',
};

function setRefreshCookie(res, refreshToken) {
  res.cookie('refresh_token', refreshToken, REFRESH_COOKIE_OPTS);
}

// ── Signup ────────────────────────────────────────────────────────

async function signup(req, res, next) {
  try {
    const data = signupSchema.parse(req.body);
    const { body } = await authService.signup(data);
    success(res, body, 201);
  } catch (err) { next(err); }
}

// ── Login ─────────────────────────────────────────────────────────

async function login(req, res, next) {
  try {
    const data      = loginSchema.parse(req.body);
    const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const clientIp  = req.ip || req.headers['x-forwarded-for'] || 'unknown';

    const payload = await authService.login({
      data, requestId, clientIp, userAgent: req.headers['user-agent'],
    });

    const { refresh_token, ...responsePayload } = payload;
    setRefreshCookie(res, refresh_token);

    success(res, responsePayload);
  } catch (err) { next(err); }
}

// ── Refresh ───────────────────────────────────────────────────────

async function refreshToken(req, res, next) {
  try {
    const result = await authService.refreshToken({ refresh_token: req.cookies.refresh_token });
    const { refresh_token, ...responsePayload } = result;
    setRefreshCookie(res, refresh_token);
    success(res, responsePayload);
  } catch (err) { next(err); }
}

// ── Logout ────────────────────────────────────────────────────────

async function logout(req, res, next) {
  try {
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });
    await authService.logout({ userId: req.user.id });
    success(res, { message: 'Logged out successfully.' });
  } catch (err) { next(err); }
}

async function logoutAllDevices(req, res, next) {
  try {
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });
    await authService.logoutAllDevices({ userId: req.user.id });
    success(res, { message: 'Logged out from all devices.' });
  } catch (err) { next(err); }
}

// ── Forgot password ───────────────────────────────────────────────

async function forgotPassword(req, res, next) {
  try {
    const data = forgotPasswordSchema.parse(req.body);
    await authService.forgotPassword({ email: data.email });
    success(res, {
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (err) { next(err); }
}

// ── Reset password (recovery-link flow only) ────────────────────────

async function resetPassword(req, res, next) {
  try {
    const data = resetPasswordSchema.parse(req.body);
    await authService.resetPassword({
      authorizationHeader: req.headers.authorization,
      password: data.password,
      userId: req.user.id,
    });
    success(res, { message: 'Password updated successfully.' });
  } catch (err) { next(err); }
}

// ── Change password (logged-in user) ────────────────────────────────

async function changePassword(req, res, next) {
  try {
    const data = changePasswordSchema.parse(req.body);
    await authService.changePassword({
      userEmail: req.user.email,
      userId: req.user.id,
      current_password: data.current_password,
      new_password: data.new_password,
    });
    success(res, { message: 'Password updated successfully.' });
  } catch (err) { next(err); }
}

// ── Google OAuth URL ──────────────────────────────────────────────

async function getGoogleAuthUrl(req, res, next) {
  try {
    const result = await authService.getGoogleAuthUrl({
      requestedRedirect: req.query.redirect_to,
      requestIp: req.ip,
    });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Google OAuth callback ─────────────────────────────────────────

async function googleCallback(req, res, next) {
  try {
    const { code } = req.body;
    const result = await authService.googleCallback({ code });
    const { refresh_token, ...responsePayload } = result;
    setRefreshCookie(res, refresh_token);
    success(res, responsePayload);
  } catch (err) { next(err); }
}

// ── Verify email ─────────────────────────────────────────────────

async function verifyEmail(req, res, next) {
  try {
    const { token_hash, type } = req.body;
    const result = await authService.verifyEmail({ token_hash, type });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Register / upsert profile ─────────────────────────────────────

async function register(req, res, next) {
  try {
    const user = await authService.register({
      userId: req.user.id,
      email: req.user.email,
      bodyRaw: req.body,
      parseRegisterSchema: (body) => registerSchema.parse(body),
    });
    success(res, { user }, 201);
  } catch (err) { next(err); }
}

// ── Get current user ──────────────────────────────────────────────
//
// req.dbUser is already populated by loadDbUser middleware upstream.

async function getMe(req, res, next) {
  try {
    const result = await authService.getMe({ userId: req.user.id, dbUser: req.dbUser || null });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Update profile ─────────────────────────────────────────────────

async function updateProfile(req, res, next) {
  try {
    const data = updateProfileSchema.parse(req.body);
    const user = await authService.updateProfile({ userId: req.user.id, data });
    success(res, { user });
  } catch (err) { next(err); }
}

// ── Avatar upload URL ─────────────────────────────────────────────

async function getAvatarUploadUrl(req, res, next) {
  try {
    const data = uploadFileSchema.parse(req.body);
    const result = await authService.getAvatarUploadUrl({
      userId: req.user.id,
      filename: data.filename, contentType: data.content_type, fileSize: data.file_size,
    });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Contacts ─────────────────────────────────────────────────────

async function getUserContacts(req, res, next) {
  try {
    const contacts = await authService.getUserContacts({ userId: req.user.id });
    success(res, { contacts });
  } catch (err) { next(err); }
}

async function upsertContact(req, res, next) {
  try {
    const { type, value, label, country_code, is_primary } = req.body;
    const contact = await authService.upsertContact({
      userId: req.user.id, type, value, label, country_code, is_primary,
    });
    success(res, { contact }, 201);
  } catch (err) { next(err); }
}

async function deleteContact(req, res, next) {
  try {
    const { contactId } = req.params;
    await authService.deleteContact({ userId: req.user.id, contactId });
    success(res, { message: 'Contact deleted successfully' });
  } catch (err) { next(err); }
}

async function updateContacts(req, res, next) {
  try {
    const data = contactSchema.parse(req.body);
    const contacts = await authService.updateContacts({ userId: req.user.id, contacts: data.contacts });
    success(res, { contacts });
  } catch (err) { next(err); }
}

// ── Push token / notification prefs ───────────────────────────────

async function registerPushToken(req, res, next) {
  try {
    const data = pushTokenSchema.parse(req.body);
    await authService.registerPushToken({ userId: req.user.id, token: data.token, platform: data.platform });
    success(res, { push_enabled: true, platform: data.platform });
  } catch (err) { next(err); }
}

async function updateNotificationPrefs(req, res, next) {
  try {
    const data = notificationPrefsSchema.parse(req.body);
    const preferences = await authService.updateNotificationPrefs({
      userId: req.user.id,
      push_enabled: data.push_enabled,
      email_digest_enabled: data.email_digest_enabled,
    });
    success(res, { preferences });
  } catch (err) { next(err); }
}

// ── Request data export (GDPR) ───────────────────────────────────

async function requestDataExport(req, res, next) {
  try {
    await authService.requestDataExport({ userId: req.user.id, userEmail: req.user.email });
    success(res, { message: 'Your data export has been queued and will be emailed within 24 hours.' });
  } catch (err) { next(err); }
}

module.exports = {
  signup,
  login,
  logout,
  logoutAllDevices,
  refreshToken,
  forgotPassword,
  resetPassword,
  changePassword,
  getGoogleAuthUrl,
  googleCallback,
  verifyEmail,
  register,
  getMe,
  updateProfile,
  getAvatarUploadUrl,
  updateContacts,
  registerPushToken,
  updateNotificationPrefs,
  requestDataExport,
  getUserContacts,
  upsertContact,
  deleteContact,
};
