// src/services/auth.service.js
//
// Extracted from auth.controller.js as part of the service-layer
// refactor. This is the largest controller in the app, so this service
// is organized in the same section order as the original for easy
// cross-reference. All Supabase Auth calls, DB reads/writes, and error
// mapping now live here; the controller only parses req/cookies/headers,
// calls these functions, and shapes the HTTP response (including setting
// the refresh_token cookie, which stays in the controller since it's an
// HTTP-transport concern, not a business rule).

const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const {
  AppError, ValidationError, UnauthorizedError, ForbiddenError, ConflictError, BusinessRuleError, NotFoundError,
} = require('../utils/errors');
const { generateUploadUrl } = require('./storage.service');
const { getQueue } = require('../queues');
const logger = require('../utils/logger');

// ── Helpers ────────────────────────────────────────────────────────

function getAuthClient() {
  if (!supabaseAuth) {
    throw new AppError(
      'SUPABASE_ANON_KEY is not configured. Auth endpoints are unavailable.',
      503,
      'SERVICE_UNAVAILABLE'
    );
  }
  return supabaseAuth;
}

// Issue L5 fix: prefers the stable `error.code` (and `error.status`)
// exposed by newer supabase-js/GoTrue versions over message-substring
// matching, which is brittle against SDK/API wording changes.
// Message-substring matching is kept as a fallback for older SDK
// versions / error shapes where `code` isn't populated.
function mapSupabaseAuthError(error) {
  const code = error?.code || '';
  const msg  = error?.message || '';

  if (code === 'user_already_exists' || msg.includes('already registered') || msg.includes('User already registered'))
    return new ConflictError('An account with this email already exists. Sign in instead.');

  if (code === 'email_not_confirmed' || msg.includes('Email not confirmed'))
    return new BusinessRuleError(
      'Please verify your email address before logging in. Check your inbox for a verification link.'
    );

  if (code === 'invalid_credentials' || msg.includes('Invalid login credentials') || msg.includes('invalid_grant'))
    return new UnauthorizedError('Invalid email or password.');

  if (code === 'over_email_send_rate_limit' || msg.includes('Email rate limit exceeded'))
    return new AppError('Too many emails sent. Please try again later.', 429, 'RATE_LIMITED');

  if (code === 'weak_password' || msg.includes('Password should be'))
    return new ValidationError(msg, 'password');

  return new AppError(msg || 'Authentication error', 400, 'AUTH_ERROR');
}

// ── Signup ────────────────────────────────────────────────────────

async function signup(data) {
  const client = getAuthClient();

  const { data: authData, error } = await client.auth.signUp({
    email:    data.email,
    password: data.password,
    options: {
      emailRedirectTo: `${process.env.FRONTEND_URL}/auth/callback`,
      data: {
        full_name: data.full_name,
        provider:  'email',
      },
    },
  });

  if (error) throw mapSupabaseAuthError(error);

  let profileCreated = true;

  if (authData?.user?.id) {
    const { error: dbError } = await supabaseAdmin
      .from('users')
      .upsert(
        {
          id:                   authData.user.id,
          email:                data.email,
          full_name:            data.full_name,
          country_of_residence: data.country_of_residence,
          timezone:             data.timezone,
          preferred_language:   data.preferred_language || 'en',
          auth_provider:        'email',
        },
        { onConflict: 'id' }
      );

    if (dbError) {
      // Issue H3 fix: no longer silently returns 201 success when the
      // profile row fails to write — flags it in the response instead so
      // the client can prompt an immediate retry of POST /auth/register,
      // which exists specifically to repair exactly this state. See
      // original controller history for full rationale.
      logger.error('Failed to create user profile on signup — auth user exists without a profile row', {
        userId: authData.user.id,
        error:  dbError.message,
      });
      profileCreated = false;
    }
  }

  if (authData?.session) {
    return {
      status: 'session',
      body: {
        message:       profileCreated
          ? 'Account created successfully.'
          : 'Account created, but profile setup is incomplete. Please call /auth/register to finish setting up your profile.',
        profile_setup_required: !profileCreated,
        access_token:  authData.session.access_token,
        refresh_token: authData.session.refresh_token,
        expires_in:    authData.session.expires_in,
        token_type:    'Bearer',
        user: {
          id:        authData.user.id,
          email:     authData.user.email,
          full_name: data.full_name,
        },
      },
    };
  }

  return {
    status: 'pending_verification',
    body: {
      message: 'Account created. Please check your email and click the verification link before logging in.',
      email:   data.email,
      profile_setup_required: !profileCreated,
    },
  };
}

// ── Login ─────────────────────────────────────────────────────────
//
// The verbose [LOGIN] console.log tracing below is preserved verbatim
// from the original controller — it's step-by-step diagnostic tracing
// for this specific flow (a historically flaky one), not general request
// logging (that's requestLogger.js). requestId/clientIp are computed in
// the controller (they're HTTP-transport concerns) and passed in.

async function login({ data, requestId, clientIp, userAgent }) {
  const startTime = Date.now();

  console.log(`[LOGIN] ${requestId} ⚡ START`, {
    ip: clientIp,
    userAgent,
    timestamp: new Date().toISOString(),
  });

  console.log(`[LOGIN] ${requestId} Validating request body...`);
  const client = getAuthClient();

  console.log(`[LOGIN] ${requestId} Validation passed`, {
    email: data.email?.toLowerCase(),
    emailLength: data.email?.length,
    hasPassword: !!data.password,
  });

  console.log(`[LOGIN] ${requestId} Calling Supabase auth.signInWithPassword...`);
  const authStart = Date.now();

  const { data: authData, error } = await client.auth.signInWithPassword({
    email: data.email,
    password: data.password,
  });

  console.log(`[LOGIN] ${requestId} Supabase auth response:`, {
    success: !!authData,
    hasError: !!error,
    errorMessage: error?.message || null,
    errorStatus: error?.status || null,
    userId: authData?.user?.id || null,
    userEmail: authData?.user?.email || null,
    hasSession: !!authData?.session,
    elapsed: `${Date.now() - authStart}ms`,
  });

  if (error) {
    console.warn(`[LOGIN] ${requestId} ❌ Auth failed:`, {
      error: error.message,
      status: error.status,
      elapsed: `${Date.now() - startTime}ms`,
    });
    throw mapSupabaseAuthError(error);
  }

  const userId = authData.user.id;
  console.log(`[LOGIN] ${requestId} Auth successful for userId: ${userId}`);

  console.log(`[LOGIN] ${requestId} Fetching user profile and memberships...`);
  const dbStart = Date.now();

  const [userResult, membershipsResult] = await Promise.all([
    supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabaseAdmin
      .from('workspace_members')
      .select('id, role, workspace_id, display_name, workspaces!inner(name, base_currency)')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('deleted_at', null),
  ]);

  console.log(`[LOGIN] ${requestId} DB queries complete:`, {
    userFound: !!userResult.data,
    userError: userResult.error?.message || null,
    membershipsCount: membershipsResult.data?.length || 0,
    membershipsError: membershipsResult.error?.message || null,
    elapsed: `${Date.now() - dbStart}ms`,
  });

  const userData = userResult.data;
  const membershipsData = membershipsResult.data || [];

  const shapedMemberships = membershipsData.map((m) => ({
    member_id: m.id,
    role: m.role,
    workspace_id: m.workspace_id,
    display_name: m.display_name,
    workspace_name: m.workspaces?.name,
    base_currency: m.workspaces?.base_currency,
  }));

  console.log(`[LOGIN] ${requestId} Shaped memberships:`, {
    count: shapedMemberships.length,
    workspaces: shapedMemberships.map(m => ({
      id: m.workspace_id,
      name: m.workspace_name,
      role: m.role,
    })),
  });

  const responsePayload = {
    access_token: authData.session.access_token,
    expires_in: authData.session.expires_in,
    token_type: 'Bearer',
    user: userData || null,
    memberships: shapedMemberships,
    profile_setup_required: !userData,
    refresh_token: authData.session.refresh_token, // controller sets cookie, then strips this
  };

  console.log(`[LOGIN] ${requestId} ✅ SUCCESS`, {
    userId,
    userEmail: authData.user.email,
    hasProfile: !!userData,
    profileSetupRequired: !userData,
    membershipsCount: shapedMemberships.length,
    elapsed: `${Date.now() - startTime}ms`,
  });

  return responsePayload;
}

// ── Refresh ───────────────────────────────────────────────────────

async function refreshToken({ refresh_token }) {
  if (!refresh_token) {
    throw new UnauthorizedError('No refresh token provided');
  }

  const client = getAuthClient();
  const { data: refreshData, error } = await client.auth.refreshSession({ refresh_token });

  if (error) throw new UnauthorizedError('Invalid or expired refresh token.');

  return {
    access_token:  refreshData.session.access_token,
    expires_in:    refreshData.session.expires_in,
    token_type:    'Bearer',
    refresh_token: refreshData.session.refresh_token, // controller sets cookie, then strips this
  };
}

// ── Logout ────────────────────────────────────────────────────────

async function logout({ userId }) {
  const { error } = await supabaseAdmin.auth.admin.signOut(userId);
  if (error) logger.warn('Supabase signOut error', { error: error.message });
}

async function logoutAllDevices({ userId }) {
  // 'global' scope revokes all sessions for the user, not just the current one
  const { error } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
  if (error) logger.warn('Supabase global signOut error', { error: error.message });
}

// ── Forgot password ───────────────────────────────────────────────

async function forgotPassword({ email }) {
  const client = getAuthClient();

  await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.FRONTEND_URL}/auth/reset-password`,
  });
}

// ── Reset password (recovery-link flow only) ────────────────────────
//
// Issue H2 fix: this endpoint checks the JWT's `amr` (Authentication
// Methods Reference) claim for a `recovery` entry, which Supabase
// includes when a session was established via the password-recovery OTP
// flow — instead of accepting any currently-valid access token. See
// original controller history for full rationale and the frontend
// dependency this depends on.

function isRecoverySession(authorizationHeader) {
  try {
    const header = authorizationHeader || '';
    const token  = header.slice(7);
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) return false;
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    const amr = Array.isArray(payload.amr) ? payload.amr : [];
    return amr.some((entry) => entry?.method === 'recovery');
  } catch (err) {
    logger.warn('Failed to decode JWT for recovery-session check', { error: err.message });
    return false;
  }
}

async function resetPassword({ authorizationHeader, password, userId }) {
  if (!isRecoverySession(authorizationHeader)) {
    throw new ForbiddenError(
      'This endpoint can only be used with a password-recovery link. ' +
      'To change your password while logged in, use /auth/change-password instead.'
    );
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
  if (error) throw mapSupabaseAuthError(error);
}

// ── Change password (logged-in user, requires current password) ────
//
// Issue H2 fix: verifies current_password by attempting a real sign-in
// before allowing the change — an attacker holding a stolen access token
// but not the account password cannot use this to lock the real owner
// out.

async function changePassword({ userEmail, userId, current_password, new_password }) {
  const client = getAuthClient();

  const { error: verifyErr } = await client.auth.signInWithPassword({
    email:    userEmail,
    password: current_password,
  });
  if (verifyErr) throw new UnauthorizedError('Current password is incorrect.');

  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: new_password });
  if (error) throw mapSupabaseAuthError(error);
}

// ── Google OAuth URL ──────────────────────────────────────────────
//
// Issue C2 fix: `redirect_to` is only honored if it starts with our own
// FRONTEND_URL origin, or matches an explicitly configured mobile
// deep-link scheme — otherwise it's a textbook OAuth open-redirect. See
// original controller history for full rationale.
//
// Issue L8 (documentation only): this app does not itself set/validate an
// OAuth `state` parameter — delegated entirely to Supabase GoTrue's
// /authorize endpoint. See original controller history.

function isAllowedGoogleRedirect(url) {
  if (!url) return false;
  if (url.startsWith(process.env.FRONTEND_URL)) return true;
  const allowedSchemes = (process.env.ALLOWED_DEEPLINK_SCHEMES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return allowedSchemes.some((scheme) => url.startsWith(scheme));
}

async function getGoogleAuthUrl({ requestedRedirect, requestIp }) {
  const defaultRedirect = `${process.env.FRONTEND_URL}/auth/callback`;
  const redirectTo      = isAllowedGoogleRedirect(requestedRedirect) ? requestedRedirect : defaultRedirect;

  if (requestedRedirect && redirectTo !== requestedRedirect) {
    logger.warn('Rejected disallowed redirect_to on /auth/google/url', { requestedRedirect, ip: requestIp });
  }

  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('redirect_to', redirectTo);

  return { url: url.toString(), provider: 'google' };
}

// ── Google OAuth callback ─────────────────────────────────────────

async function googleCallback({ code }) {
  if (!code) throw new ValidationError('code is required', 'code');

  const client = getAuthClient();
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) throw mapSupabaseAuthError(error);

  const session = data.session;
  const user    = data.user;

  if (user?.id) {
    const { error: dbError } = await supabaseAdmin.from('users').upsert({
      id:            user.id,
      email:         user.email,
      full_name:     user.user_metadata?.full_name || user.user_metadata?.name || null,
      avatar_url:    user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
      auth_provider: 'google',
    }, { onConflict: 'id' });

    if (dbError) {
      // Same orphaned-profile risk as email signup (issue H3).
      logger.error('Failed to upsert user profile on Google OAuth callback', { userId: user.id, error: dbError.message });
    }
  }

  return {
    access_token:  session.access_token,
    expires_in:    session.expires_in,
    token_type:    'Bearer',
    user: { id: user.id, email: user.email },
    refresh_token: session.refresh_token, // controller sets cookie, then strips this
  };
}

// ── Verify email ─────────────────────────────────────────────────

async function verifyEmail({ token_hash, type }) {
  if (!token_hash) throw new ValidationError('token_hash is required', 'token_hash');

  const client = getAuthClient();
  const { data, error } = await client.auth.verifyOtp({ token_hash, type: type || 'email' });
  if (error) throw mapSupabaseAuthError(error);

  return {
    message:       'Email verified successfully.',
    access_token:  data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    expires_in:    data.session?.expires_in,
    token_type:    'Bearer',
  };
}

// ── Register / upsert profile ─────────────────────────────────────

async function register({ userId, email, bodyRaw, parseRegisterSchema }) {
  const { data: { user: sbUser }, error: sbErr } =
    await supabaseAdmin.auth.admin.getUserById(userId);
  if (sbErr) logger.warn('Could not fetch Supabase user metadata', { userId });

  const userMeta = sbUser?.user_metadata || {};
  const appMeta  = sbUser?.app_metadata  || {};
  const provider = appMeta.provider || userMeta.provider || 'email';
  const isOAuth  = provider !== 'email';

  let bodyData = {};
  try {
    bodyData = parseRegisterSchema(bodyRaw);
  } catch (validationErr) {
    if (!isOAuth) throw validationErr;
  }

  const fullName = bodyData.full_name || userMeta.full_name || userMeta.name || null;
  if (!fullName && !isOAuth) throw new ValidationError('full_name is required', 'full_name');

  const countryOfResidence = bodyData.country_of_residence || null;
  const timezone           = bodyData.timezone             || null;
  const preferredLanguage  = bodyData.preferred_language   || 'en';
  const avatarUrl          = userMeta.avatar_url || userMeta.picture || null;
  const dbProvider         = isOAuth && provider === 'google' ? 'google' : 'email';

  const { data, error } = await supabaseAdmin
    .from('users')
    .upsert(
      {
        id:                   userId,
        email,
        full_name:            fullName,
        country_of_residence: countryOfResidence,
        timezone,
        preferred_language:   preferredLanguage,
        avatar_url:           avatarUrl,
        auth_provider:        dbProvider,
      },
      { onConflict: 'id' }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// ── Get current user ──────────────────────────────────────────────

async function getMe({ userId, dbUser }) {
  const { data: membershipsData, error: mErr } = await supabaseAdmin
    .from('workspace_members')
    .select('id, role, workspace_id, display_name, workspaces!inner(name, base_currency)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .is('deleted_at', null);

  if (mErr) throw new Error(mErr.message);

  const shapedMemberships = (membershipsData || []).map((m) => ({
    member_id:      m.id,
    role:           m.role,
    workspace_id:   m.workspace_id,
    display_name:   m.display_name,
    workspace_name: m.workspaces?.name,
    base_currency:  m.workspaces?.base_currency,
  }));

  return { user: dbUser || null, memberships: shapedMemberships };
}

// ── Update profile ─────────────────────────────────────────────────

const PROFILE_UPDATE_ALLOWED_FIELDS = [
  'full_name', 'bio', 'country_of_residence', 'timezone',
  'avatar_url', 'push_enabled', 'email_digest_enabled', 'preferred_language',
];

async function updateProfile({ userId, data }) {
  const updates = {};
  for (const field of PROFILE_UPDATE_ALLOWED_FIELDS) {
    if (data[field] !== undefined) updates[field] = data[field];
  }

  if (!Object.keys(updates).length) {
    const { data: user } = await supabaseAdmin
      .from('users').select('*').eq('id', userId).single();
    return user;
  }

  updates.updated_at = new Date().toISOString();
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return user;
}

// ── Avatar upload URL ─────────────────────────────────────────────

async function getAvatarUploadUrl({ userId, filename, contentType, fileSize }) {
  return generateUploadUrl({
    userId,
    folder:      'avatars',
    filename,
    contentType,
    fileSize,
    fileType:    'avatar',
  });
}

// ── Contacts ─────────────────────────────────────────────────────

async function getUserContacts({ userId }) {
  const { data, error } = await supabaseAdmin
    .from('user_contacts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// upsert_primary_contact runs the is_primary=false demotion and the
// upsert atomically, so two concurrent calls can't both end up with
// is_primary=true for the same contact type.
async function upsertContact({ userId, type, value, label, country_code, is_primary }) {
  if (!type || !value) {
    throw new ValidationError('type and value are required');
  }

  const { data, error } = await supabaseAdmin.rpc('upsert_primary_contact', {
    p_user_id:      userId,
    p_type:         type,
    p_value:        value,
    p_label:        label        || null,
    p_country_code: country_code || null,
    p_is_primary:   is_primary   || false,
  });

  if (error) throw new Error(error.message);
  return data;
}

// .select('id').maybeSingle() detects a no-op delete (nothing matched) so
// a non-existent contactId returns 404 instead of a false-positive 200.
async function deleteContact({ userId, contactId }) {
  const { data, error } = await supabaseAdmin
    .from('user_contacts')
    .delete()
    .eq('id', contactId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError('Contact not found');
}

// Issue M17 fix: single atomic RPC (replace_user_contacts_atomic) instead
// of a separate DELETE-by-type followed by a batch UPSERT, closing the
// window where a failed upsert after a successful delete could lose
// contact methods with no rollback.
async function updateContacts({ userId, contacts }) {
  const types = [...new Set(contacts.map((c) => c.type))];

  const { data: resultContacts, error } = await supabaseAdmin.rpc('replace_user_contacts_atomic', {
    p_user_id:  userId,
    p_types:    types,
    p_contacts: contacts.map((contact) => ({
      type:         contact.type,
      label:        contact.label        || null,
      value:        contact.value,
      country_code: contact.country_code || null,
      is_primary:   contact.is_primary   ?? false,
    })),
  });

  if (error) throw new Error(error.message);
  return resultContacts || [];
}

// ── Push token / notification prefs ───────────────────────────────

async function registerPushToken({ userId, token, platform }) {
  const { error } = await supabaseAdmin
    .from('users')
    .update({
      push_token:          token,
      push_token_platform: platform,
      push_enabled:        true,
      updated_at:          new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw new Error(error.message);
}

async function updateNotificationPrefs({ userId, push_enabled, email_digest_enabled }) {
  const updates = {};
  if (push_enabled         !== undefined) updates.push_enabled         = push_enabled;
  if (email_digest_enabled !== undefined) updates.email_digest_enabled = email_digest_enabled;

  if (Object.keys(updates).length) {
    updates.updated_at = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('users').update(updates).eq('id', userId);
    if (error) throw new Error(error.message);
  }

  const { data: prefs, error } = await supabaseAdmin
    .from('users')
    .select('push_enabled, email_digest_enabled')
    .eq('id', userId)
    .single();

  if (error) throw new Error(error.message);
  return prefs;
}

// ── Request data export (GDPR) ───────────────────────────────────

async function requestDataExport({ userId, userEmail }) {
  const { data: memberships } = await supabaseAdmin
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .is('deleted_at', null);

  const workspaceIds = (memberships || []).map((m) => m.workspace_id);

  await getQueue('data-export-queue').add(
    'export-user-data',
    { userId, userEmail, workspaceIds },
    { attempts: 2, backoff: { type: 'exponential', delay: 10000 } }
  );
}

module.exports = {
  mapSupabaseAuthError,
  isRecoverySession,
  isAllowedGoogleRedirect,
  signup,
  login,
  refreshToken,
  logout,
  logoutAllDevices,
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
  getUserContacts,
  upsertContact,
  deleteContact,
  updateContacts,
  registerPushToken,
  updateNotificationPrefs,
  requestDataExport,
};
