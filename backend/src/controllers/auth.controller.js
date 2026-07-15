// src/controllers/auth.controller.js
const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const { success } = require('../utils/response');
const {
  AppError, ValidationError, UnauthorizedError, ForbiddenError, ConflictError, BusinessRuleError, NotFoundError,
} = require('../utils/errors');
const {
  signupSchema, loginSchema, registerSchema, forgotPasswordSchema,
  resetPasswordSchema, changePasswordSchema, updateProfileSchema, contactSchema, pushTokenSchema,
  notificationPrefsSchema, refreshTokenSchema,
} = require('../validators/auth.validator');
const { uploadFileSchema }  = require('../validators/ledger.validator');
const { generateUploadUrl } = require('../services/storage.service');
// Used by requestDataExport below
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

// Issue L5 fix: previously matched purely on error.message substrings,
// which is brittle against Supabase SDK/API wording changes. Newer
// supabase-js/GoTrue versions expose a stable `error.code` (and
// `error.status`) that should be preferred. Message-substring matching is
// kept as a fallback for older SDK versions / error shapes where `code`
// isn't populated, rather than removed outright — this is a safety net,
// not a primary mechanism.
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

async function signup(req, res, next) {
  try {
    const data   = signupSchema.parse(req.body);
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

    if (error) return next(mapSupabaseAuthError(error));

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
        // Issue H3 fix: this previously logged the failure and returned
        // 201 success anyway, leaving the client believing signup fully
        // succeeded when the user now has a working Supabase Auth identity
        // but no application profile row. Every downstream flow that
        // depends on req.dbUser (loadDbUser middleware) will break for
        // this user. We can't roll back the already-created Supabase Auth
        // user from here without risking losing the account entirely if
        // THIS request also fails, so instead: flag it clearly in the
        // response so the client can prompt an immediate retry of the
        // already-idempotent POST /auth/register endpoint, which exists
        // specifically to repair exactly this state.
        logger.error('Failed to create user profile on signup — auth user exists without a profile row', {
          userId: authData.user.id,
          error:  dbError.message,
        });
        profileCreated = false;
      }
    }

    if (authData?.session) {
      return success(res, {
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
      }, 201);
    }

    success(res, {
      message: 'Account created. Please check your email and click the verification link before logging in.',
      email:   data.email,
      profile_setup_required: !profileCreated,
    }, 201);
  } catch (err) { next(err); }
}

// ── Login ─────────────────────────────────────────────────────────

async function login(req, res, next) {
  try {
    const data = loginSchema.parse(req.body);
    const client = getAuthClient();

    const { data: authData, error } = await client.auth.signInWithPassword({
      email: data.email, password: data.password,
    });
    if (error) return next(mapSupabaseAuthError(error));

    const [userResult, membershipsResult] = await Promise.all([
      supabaseAdmin
        .from('users')
        .select('*')
        .eq('id', authData.user.id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabaseAdmin
        .from('workspace_members')
        .select('id, role, workspace_id, display_name, workspaces!inner(name, base_currency)')
        .eq('user_id', authData.user.id)
        .eq('is_active', true)
        .is('deleted_at', null),
    ]);

    const userData        = userResult.data;
    const membershipsData = membershipsResult.data || [];

    const shapedMemberships = membershipsData.map((m) => ({
      member_id:      m.id,
      role:           m.role,
      workspace_id:   m.workspace_id,
      display_name:   m.display_name,
      workspace_name: m.workspaces?.name,
      base_currency:  m.workspaces?.base_currency,
    }));

    // Must match the path this cookie is cleared/refreshed on (see logout, refreshToken).
    res.cookie('refresh_token', authData.session.refresh_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/v1/auth/refresh',
    });

    success(res, {
      access_token: authData.session.access_token,
      expires_in:   authData.session.expires_in,
      token_type:   'Bearer',
      user:         userData || null,
      memberships:  shapedMemberships,
      profile_setup_required: !userData,
    });
  } catch (err) { next(err); }
}

// ── Refresh ───────────────────────────────────────────────────────

async function refreshToken(req, res, next) {
  try {
    const refresh_token = req.cookies.refresh_token;

    if (!refresh_token) {
      return next(new UnauthorizedError('No refresh token provided'));
    }

    const client = getAuthClient();
    const { data: refreshData, error } = await client.auth.refreshSession({
      refresh_token,
    });

    if (error) return next(new UnauthorizedError('Invalid or expired refresh token.'));

    // Must match the path this cookie is cleared/refreshed on (see logout, refreshToken).
    res.cookie('refresh_token', refreshData.session.refresh_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/v1/auth/refresh',
    });

    success(res, {
      access_token: refreshData.session.access_token,
      expires_in:   refreshData.session.expires_in,
      token_type:   'Bearer',
    });
  } catch (err) { next(err); }
}

// ── Logout ────────────────────────────────────────────────────────

async function logout(req, res, next) {
  try {
    // Must match the path this cookie is cleared/refreshed on (see logout, refreshToken).
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });

    const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id);
    if (error) logger.warn('Supabase signOut error', { error: error.message });
    success(res, { message: 'Logged out successfully.' });
  } catch (err) { next(err); }
}

// ── Logout all devices ──────────────────────────────────────────

async function logoutAllDevices(req, res, next) {
  try {
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });
    // 'global' scope revokes all sessions for the user, not just the current one
    const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id, 'global');
    if (error) logger.warn('Supabase global signOut error', { error: error.message });
    success(res, { message: 'Logged out from all devices.' });
  } catch (err) { next(err); }
}

// ── Forgot password ───────────────────────────────────────────────

async function forgotPassword(req, res, next) {
  try {
    const data   = forgotPasswordSchema.parse(req.body);
    const client = getAuthClient();

    await client.auth.resetPasswordForEmail(data.email, {
      redirectTo: `${process.env.FRONTEND_URL}/auth/reset-password`,
    });

    success(res, {
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (err) { next(err); }
}

// ── Reset password (recovery-link flow only) ────────────────────────
//
// Issue H2 fix: the route comment claimed this "requires the short-lived
// recovery JWT from the reset email," but requireAuth did not actually
// distinguish a recovery-flow token from an ordinary login session token
// — it just called supabaseAdmin.auth.getUser(token). That meant ANY
// currently-valid access token (e.g. one obtained via a stolen-but-not-
// yet-expired device session) could reach this endpoint and change the
// account password with no re-entry of the current password.
//
// Now: this endpoint checks the JWT's `amr` (Authentication Methods
// Reference) claim for a `recovery` entry, which Supabase includes when a
// session was established via the password-recovery OTP flow. If that
// claim isn't present, the request is rejected with instructions to use
// the new /auth/change-password endpoint instead (for logged-in users who
// know their current password and just want to change it).
//
// VERIFY AGAINST YOUR SUPABASE PROJECT: decode a real recovery-flow access
// token (jwt.io or `Buffer.from(token.split('.')[1], 'base64url')`) and
// confirm the payload actually contains `amr: [{ method: 'recovery', ... }]`
// (or similar). This is standard Supabase GoTrue behavior, but auth
// provider internals can change between versions — please confirm on your
// project before removing the old /auth/reset-password behavior from any
// client that still relies on it as a general-purpose "change password"
// endpoint.
//
// FRONTEND DEPENDENCY: the recovery-link screen (reached by clicking the
// emailed reset link) should keep calling POST /auth/reset-password
// unchanged. Any "change password" screen inside account settings (for an
// already-logged-in user) must switch to POST /auth/change-password,
// which now requires `current_password` in the body.

function isRecoverySession(req) {
  try {
    const header = req.headers.authorization || '';
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

async function resetPassword(req, res, next) {
  try {
    if (!isRecoverySession(req)) {
      throw new ForbiddenError(
        'This endpoint can only be used with a password-recovery link. ' +
        'To change your password while logged in, use /auth/change-password instead.'
      );
    }

    const data = resetPasswordSchema.parse(req.body);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      password: data.password,
    });
    if (error) return next(mapSupabaseAuthError(error));
    success(res, { message: 'Password updated successfully.' });
  } catch (err) { next(err); }
}

// ── Change password (logged-in user, requires current password) ────
//
// Issue H2 fix: new endpoint for the "change password from account
// settings" use case, distinct from the recovery-link flow above.
// Verifies current_password by attempting a real sign-in before allowing
// the change — an attacker holding a stolen access token but not the
// account password cannot use this to lock the real owner out.

async function changePassword(req, res, next) {
  try {
    const data = changePasswordSchema.parse(req.body);
    const client = getAuthClient();

    const { error: verifyErr } = await client.auth.signInWithPassword({
      email:    req.user.email,
      password: data.current_password,
    });
    if (verifyErr) throw new UnauthorizedError('Current password is incorrect.');

    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      password: data.new_password,
    });
    if (error) return next(mapSupabaseAuthError(error));

    success(res, { message: 'Password updated successfully.' });
  } catch (err) { next(err); }
}

// ── Google OAuth URL ──────────────────────────────────────────────
//
// Issue C2 fix: `redirect_to` was previously taken directly from an
// unauthenticated public query parameter and embedded in the Supabase
// /authorize URL with no validation — a textbook OAuth open-redirect:
// GET /v1/auth/google/url?redirect_to=https://evil.example.com/harvest
// would send the victim, post-authentication, to an attacker-controlled
// domain, potentially carrying auth codes/tokens with it.
//
// Now: `redirect_to` is only honored if it starts with our own
// FRONTEND_URL origin, or matches an explicitly configured mobile deep-link
// scheme. Anything else falls back to the safe default. If the mobile app
// needs a custom deep-link scheme (e.g. `kith://auth/callback`), set
// ALLOWED_DEEPLINK_SCHEMES="kith://" (comma-separated for multiple) —
// FRONTEND DEPENDENCY: confirm with the mobile client which scheme(s), if
// any, it actually relies on, since this now rejects anything not on that
// list instead of blindly trusting it.

// Issue L8 fix (documentation only): this app does not itself set or
// validate an OAuth `state` parameter — that responsibility is delegated
// entirely to Supabase's GoTrue /authorize endpoint, which is expected to
// generate and verify its own CSRF state internally as part of the
// standard OAuth authorization-code flow. This is a reasonable default
// for most Supabase projects, but it's an assumption about Supabase's
// internals rather than something verified in this codebase — worth
// confirming against Supabase's current documentation/behavior for your
// project's GoTrue version if this flow is ever audited for CSRF
// specifically.
function isAllowedGoogleRedirect(url) {
  if (!url) return false;
  if (url.startsWith(process.env.FRONTEND_URL)) return true;
  const allowedSchemes = (process.env.ALLOWED_DEEPLINK_SCHEMES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return allowedSchemes.some((scheme) => url.startsWith(scheme));
}

async function getGoogleAuthUrl(req, res, next) {
  try {
    const requestedRedirect = req.query.redirect_to;
    const defaultRedirect   = `${process.env.FRONTEND_URL}/auth/callback`;
    const redirectTo        = isAllowedGoogleRedirect(requestedRedirect) ? requestedRedirect : defaultRedirect;

    if (requestedRedirect && redirectTo !== requestedRedirect) {
      logger.warn('Rejected disallowed redirect_to on /auth/google/url', { requestedRedirect, ip: req.ip });
    }

    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', redirectTo);
    success(res, { url: url.toString(), provider: 'google' });
  } catch (err) { next(err); }
}

// ── Google OAuth callback ─────────────────────────────────────────

async function googleCallback(req, res, next) {
  try {
    const { code } = req.body;
    if (!code) throw new ValidationError('code is required', 'code');

    const client = getAuthClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error) return next(mapSupabaseAuthError(error));

    const session = data.session;
    const user    = data.user;

    // Ensure user profile exists (upsert)
    if (user?.id) {
      const { error: dbError } = await supabaseAdmin.from('users').upsert({
        id:            user.id,
        email:         user.email,
        full_name:     user.user_metadata?.full_name || user.user_metadata?.name || null,
        avatar_url:    user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
        auth_provider: 'google',
      }, { onConflict: 'id' });

      if (dbError) {
        // Same orphaned-profile risk as email signup (Issue H3) — log
        // loudly rather than swallowing silently. The client's subsequent
        // GET /auth/me (or POST /auth/register) will surface the missing
        // profile and can prompt a retry.
        logger.error('Failed to upsert user profile on Google OAuth callback', { userId: user.id, error: dbError.message });
      }
    }

    // Must match the path this cookie is cleared/refreshed on (see logout, refreshToken).
    res.cookie('refresh_token', session.refresh_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/v1/auth/refresh',
    });

    success(res, {
      access_token: session.access_token,
      expires_in:   session.expires_in,
      token_type:   'Bearer',
      user: { id: user.id, email: user.email },
    });
  } catch (err) { next(err); }
}

// ── Verify email ─────────────────────────────────────────────────

async function verifyEmail(req, res, next) {
  try {
    const { token_hash, type } = req.body;
    if (!token_hash) throw new ValidationError('token_hash is required', 'token_hash');

    const client = getAuthClient();
    const { data, error } = await client.auth.verifyOtp({ token_hash, type: type || 'email' });
    if (error) return next(mapSupabaseAuthError(error));

    success(res, {
      message:       'Email verified successfully.',
      access_token:  data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_in:    data.session?.expires_in,
      token_type:    'Bearer',
    });
  } catch (err) { next(err); }
}

// ── Register / upsert profile ─────────────────────────────────────

async function register(req, res, next) {
  try {
    const userId = req.user.id;
    const email  = req.user.email;

    const { data: { user: sbUser }, error: sbErr } =
      await supabaseAdmin.auth.admin.getUserById(userId);
    if (sbErr) logger.warn('Could not fetch Supabase user metadata', { userId });

    const userMeta = sbUser?.user_metadata || {};
    const appMeta  = sbUser?.app_metadata  || {};
    const provider = appMeta.provider || userMeta.provider || 'email';
    const isOAuth  = provider !== 'email';

    let bodyData = {};
    try {
      bodyData = registerSchema.parse(req.body);
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
    success(res, { user: data }, 201);
  } catch (err) { next(err); }
}

// ── Get current user ──────────────────────────────────────────────
//
// GET /auth/me runs requireAuth, loadDbUser, then this handler — req.dbUser
// is already populated, so this reuses it instead of a second query.

async function getMe(req, res, next) {
  try {
    const userId = req.user.id;

    const user = req.dbUser || null;

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

    success(res, { user, memberships: shapedMemberships });
  } catch (err) { next(err); }
}

// ── Update profile ─────────────────────────────────────────────────

async function updateProfile(req, res, next) {
  try {
    const data   = updateProfileSchema.parse(req.body);
    const userId = req.user.id;

    const updates = {};
    const allowedFields = [
      'full_name', 'bio', 'country_of_residence', 'timezone',
      'avatar_url', 'push_enabled', 'email_digest_enabled', 'preferred_language',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (!Object.keys(updates).length) {
      const { data: user } = await supabaseAdmin
        .from('users').select('*').eq('id', userId).single();
      return success(res, { user });
    }

    updates.updated_at = new Date().toISOString();
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    success(res, { user });
  } catch (err) { next(err); }
}

// ── Avatar upload URL ─────────────────────────────────────────────

async function getAvatarUploadUrl(req, res, next) {
  try {
    const data   = uploadFileSchema.parse(req.body);
    const result = await generateUploadUrl({
      userId:      req.user.id,
      folder:      'avatars',
      filename:    data.filename,
      contentType: data.content_type,
      fileSize:    data.file_size,
      fileType:    'avatar',
    });
    success(res, result);
  } catch (err) { next(err); }
}

// ── Get all contacts for current user ─────────────────────────────

async function getUserContacts(req, res, next) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabaseAdmin
      .from('user_contacts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    success(res, { contacts: data || [] });
  } catch (err) { next(err); }
}

// ── Add or update a single contact ────────────────────────────────
//
// upsert_primary_contact runs the is_primary=false demotion and the
// upsert atomically, so two concurrent calls can't both end up with
// is_primary=true for the same contact type.

async function upsertContact(req, res, next) {
  try {
    const userId = req.user.id;
    const { type, value, label, country_code, is_primary } = req.body;

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
    success(res, { contact: data }, 201);
  } catch (err) { next(err); }
}

// ── Delete a contact by ID ────────────────────────────────────────
//
// .select('id').maybeSingle() detects a no-op delete (nothing matched)
// so a non-existent contactId returns 404 instead of a false-positive 200.

async function deleteContact(req, res, next) {
  try {
    const userId = req.user.id;
    const { contactId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('user_contacts')
      .delete()
      .eq('id', contactId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundError('Contact not found');

    success(res, { message: 'Contact deleted successfully' });
  } catch (err) { next(err); }
}

// ── Update contacts — bulk replace ────────────────────────────────
//
// M17 (open): this is still a two-step, non-atomic write (DELETE by type,
// then batch UPSERT) — the same TOCTOU class of bug already fixed via RPC
// in upsertContact just above. Needs a `replace_user_contacts_atomic` RPC
// once the real user_contacts schema is available (see migrations/).

async function updateContacts(req, res, next) {
  try {
    const data   = contactSchema.parse(req.body);
    const userId = req.user.id;

    const types = [...new Set(data.contacts.map((c) => c.type))];

    // Issue M17 fix: previously a separate DELETE (by type) followed by a
    // batch UPSERT — if the upsert failed after the delete succeeded, the
    // user would lose those contact methods with no rollback. Now a
    // single atomic RPC (see migrations/0003_replace_user_contacts_atomic.sql),
    // consistent with the pattern already used in upsertContact above.
    // Also removes the need for a separate final SELECT — the RPC returns
    // the resulting rows directly.
    const { data: contacts, error } = await supabaseAdmin.rpc('replace_user_contacts_atomic', {
      p_user_id:  userId,
      p_types:    types,
      p_contacts: data.contacts.map((contact) => ({
        type:         contact.type,
        label:        contact.label        || null,
        value:        contact.value,
        country_code: contact.country_code || null,
        is_primary:   contact.is_primary   ?? false,
      })),
    });

    if (error) throw new Error(error.message);

    success(res, { contacts: contacts || [] });
  } catch (err) { next(err); }
}

// ── Register push token ───────────────────────────────────────────

async function registerPushToken(req, res, next) {
  try {
    const data   = pushTokenSchema.parse(req.body);
    const userId = req.user.id;

    const { error } = await supabaseAdmin
      .from('users')
      .update({
        push_token:          data.token,
        push_token_platform: data.platform,
        push_enabled:        true,
        updated_at:          new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) throw new Error(error.message);
    success(res, { push_enabled: true, platform: data.platform });
  } catch (err) { next(err); }
}

// ── Update notification preferences ──────────────────────────────

async function updateNotificationPrefs(req, res, next) {
  try {
    const data   = notificationPrefsSchema.parse(req.body);
    const userId = req.user.id;

    const updates = {};
    if (data.push_enabled         !== undefined) updates.push_enabled         = data.push_enabled;
    if (data.email_digest_enabled !== undefined) updates.email_digest_enabled = data.email_digest_enabled;

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
    success(res, { preferences: prefs });
  } catch (err) { next(err); }
}

// ── Request data export (GDPR) ───────────────────────────────────
//
// Fetches the user's workspace memberships and enqueues an async job that
// exports ledger/task data and emails it to the user.

async function requestDataExport(req, res, next) {
  try {
    const userId    = req.user.id;
    const userEmail = req.user.email;

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
  // Individual contact management
  getUserContacts,
  upsertContact,
  deleteContact,
};
