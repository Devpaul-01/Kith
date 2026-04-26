// src/controllers/auth.controller.js
const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const { success } = require('../utils/response');
const {
  AppError, ValidationError, UnauthorizedError, ConflictError, BusinessRuleError, NotFoundError,
} = require('../utils/errors');
const {
  signupSchema, loginSchema, registerSchema, forgotPasswordSchema,
  resetPasswordSchema, updateProfileSchema, contactSchema, pushTokenSchema,
  notificationPrefsSchema, refreshTokenSchema,
} = require('../validators/auth.validator');
const { uploadFileSchema }  = require('../validators/ledger.validator');
const { generateUploadUrl } = require('../services/storage.service');
// Issue 21: queue import for data export
const { getQueue } = require('../queues');

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

function mapSupabaseAuthError(error) {
  const msg = error?.message || '';
  if (msg.includes('already registered') || msg.includes('User already registered'))
    return new ConflictError('An account with this email already exists. Sign in instead.');
  if (msg.includes('Email not confirmed'))
    return new BusinessRuleError(
      'Please verify your email address before logging in. Check your inbox for a verification link.'
    );
  if (msg.includes('Invalid login credentials') || msg.includes('invalid_grant'))
    return new UnauthorizedError('Invalid email or password.');
  if (msg.includes('Email rate limit exceeded'))
    return new AppError('Too many emails sent. Please try again later.', 429, 'RATE_LIMITED');
  if (msg.includes('Password should be'))
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
        require('../utils/logger').error('Failed to create user profile on signup', {
          userId: authData.user.id,
          error:  dbError.message,
        });
      }
    }

    if (authData?.session) {
      return success(res, {
        message:       'Account created successfully.',
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

    // Issue 1 fix: path changed from '/api/auth/refresh' to '/v1/auth/refresh'
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

    // Issue 1 fix: path changed from '/api/auth/refresh' to '/v1/auth/refresh'
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
    // Issue 1 fix: path changed from '/api/auth/refresh' to '/v1/auth/refresh'
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });

    const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id);
    if (error) require('../utils/logger').warn('Supabase signOut error', { error: error.message });
    success(res, { message: 'Logged out successfully.' });
  } catch (err) { next(err); }
}

// ── Logout all devices (Issue 5.6) ───────────────────────────────

async function logoutAllDevices(req, res, next) {
  try {
    res.clearCookie('refresh_token', { path: '/v1/auth/refresh' });
    // 'global' scope revokes all sessions for the user, not just the current one
    const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id, 'global');
    if (error) require('../utils/logger').warn('Supabase global signOut error', { error: error.message });
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

// ── Reset password ────────────────────────────────────────────────

async function resetPassword(req, res, next) {
  try {
    const data = resetPasswordSchema.parse(req.body);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      password: data.password,
    });
    if (error) return next(mapSupabaseAuthError(error));
    success(res, { message: 'Password updated successfully.' });
  } catch (err) { next(err); }
}

// ── Google OAuth URL ──────────────────────────────────────────────

async function getGoogleAuthUrl(req, res, next) {
  try {
    const redirectTo = req.query.redirect_to || `${process.env.FRONTEND_URL}/auth/callback`;
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
    url.searchParams.set('provider', 'google');
    url.searchParams.set('redirect_to', redirectTo);
    success(res, { url: url.toString(), provider: 'google' });
  } catch (err) { next(err); }
}

// ── Google OAuth callback (Issue 5.5) ─────────────────────────────

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
      await supabaseAdmin.from('users').upsert({
        id:            user.id,
        email:         user.email,
        full_name:     user.user_metadata?.full_name || user.user_metadata?.name || null,
        avatar_url:    user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
        auth_provider: 'google',
      }, { onConflict: 'id' });
    }

    // Issue 1 fix: correct path used here too
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

// ── Verify email (Issue 5.4) ──────────────────────────────────────

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
    if (sbErr) require('../utils/logger').warn('Could not fetch Supabase user metadata', { userId });

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
// Issue 2 fix: removed the first (dead-code) duplicate definition of getMe
// that appeared between the Login comment block and the login function.
//
// Issue 7 fix: req.dbUser is already populated by loadDbUser middleware on
// this route (GET /auth/me uses requireAuth, loadDbUser, ctrl.getMe).
// The previous implementation ignored req.dbUser and ran a second
// supabaseAdmin.from('users').select('*') query — an unnecessary round-trip.

async function getMe(req, res, next) {
  try {
    const userId = req.user.id;

    // Issue 7: use req.dbUser already populated by loadDbUser — no second query
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

// ── Add or update a single contact (Issue 13 — atomic RPC) ────────
//
// Issue 13 fix: replaced two sequential writes (UPDATE is_primary=false, then
// UPSERT) with a single atomic RPC to eliminate the TOCTOU race condition that
// could result in multiple contacts of the same type having is_primary=true.

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

// ── Delete a contact by ID (Issue 4 — 404 on missing) ─────────────
//
// Issue 4 fix: the previous implementation did not check whether any row was
// actually deleted, returning 200 even for non-existent contactIds.
// Now uses .select('id').maybeSingle() to detect no-op deletes.

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

// ── Update contacts — bulk replace (Issue 12 — batch upsert) ──────
//
// Issue 12 fix: replaced serial for...of loop (N round-trips) with a single
// batch upsert, consistent with how the workers handle bulk writes.

async function updateContacts(req, res, next) {
  try {
    const data   = contactSchema.parse(req.body);
    const userId = req.user.id;

    const types = [...new Set(data.contacts.map((c) => c.type))];

    await supabaseAdmin
      .from('user_contacts')
      .delete()
      .eq('user_id', userId)
      .in('type', types);

    // Issue 12: single batch upsert instead of N sequential upserts
    const upsertRows = data.contacts.map((contact) => ({
      user_id:      userId,
      type:         contact.type,
      label:        contact.label        || null,
      value:        contact.value,
      country_code: contact.country_code || null,
      is_primary:   contact.is_primary   ?? false,
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from('user_contacts')
      .upsert(upsertRows, { onConflict: 'user_id,type,value' });

    if (upsertErr) throw new Error(upsertErr.message);

    const { data: contacts, error } = await supabaseAdmin
      .from('user_contacts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at');

    if (error) throw new Error(error.message);
    success(res, { contacts });
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

// ── Request data export (Issue 21) ───────────────────────────────
//
// Issue 21 fix: was a no-op stub. Now fetches the user's workspace memberships
// and enqueues an async job that exports ledger data and emails it to the user.

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
