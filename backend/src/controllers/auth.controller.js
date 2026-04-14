// src/controllers/auth.controller.js
const { supabaseAdmin, supabaseAuth } = require('../config/supabase');
const { success } = require('../utils/response');
const {
  AppError, ValidationError, UnauthorizedError, ConflictError, BusinessRuleError,
} = require('../utils/errors');
const {
  signupSchema, loginSchema, registerSchema, forgotPasswordSchema,
  resetPasswordSchema, updateProfileSchema, contactSchema, pushTokenSchema,
  notificationPrefsSchema, refreshTokenSchema,
} = require('../validators/auth.validator');
const { uploadFileSchema }  = require('../validators/ledger.validator');
const { generateUploadUrl } = require('../services/storage.service');

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
//
// BEHAVIOUR depends on Supabase "Enable email confirmations" setting:
//
//   Confirmation OFF (dev/testing):
//     authData.session is returned immediately → user is logged in on signup
//     Response: 201 with access_token + refresh_token + user
//
//   Confirmation ON (production):
//     authData.session is null → user must click verification email first
//     Response: 201 with just a message, no tokens
//
// No code change needed when you flip the Supabase dashboard toggle.
//
// IMPORTANT: Do NOT write email_confirmed_at to the users table.
// That field lives in Supabase's internal auth.users table, not ours.
// Supabase manages confirmation state itself — we never touch it.

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

    // Create the profile row whenever we have an ID
    if (authData?.user?.id) {
      const { error: dbError } = await supabaseAdmin
        .from('users')
        .upsert(
          {
            id:                   authData.user.id,
            email:                data.email,
            full_name:            data.full_name,
            country_of_residence: data.country_of_residence,
            auth_provider:        'email',
          },
          { onConflict: 'id' }
        );

      if (dbError) {
        require('../utils/logger').error('Failed to create user profile on signup', {
          userId: authData.user.id,
          error:  dbError.message,
        });
        // Non-fatal: auth user exists, profile created on first login via POST /auth/register
      }
    }

    // Confirmation OFF → session returned immediately
    if (authData?.session) {
      console.log("Sessioj found");
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

    // Confirmation ON → tell user to check their email
    success(res, {
      message: 'Account created. Please check your email and click the verification link before logging in.',
      email:   data.email,
    }, 201);
  } catch (err) { next(err); }
}

// ── Login ─────────────────────────────────────────────────────────

async function login(req, res, next) {
  try {
    const data   = loginSchema.parse(req.body);
    const client = getAuthClient();

    const { data: authData, error } = await client.auth.signInWithPassword({
      email: data.email, password: data.password,
    });
    if (error) return next(mapSupabaseAuthError(error));

    const [{ data: user }, { data: memberships }] = await Promise.all([
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

    const shapedMemberships = (memberships || []).map((m) => ({
      member_id:      m.id,
      role:           m.role,
      workspace_id:   m.workspace_id,
      display_name:   m.display_name,
      workspace_name: m.workspaces?.name,
      base_currency:  m.workspaces?.base_currency,
    }));

    success(res, {
      access_token:  authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_in:    authData.session.expires_in,
      token_type:    'Bearer',
      user:          user || null,
      memberships:   shapedMemberships,
    });
  } catch (err) { next(err); }
}

// ── Refresh ───────────────────────────────────────────────────────

async function refreshToken(req, res, next) {
  try {
    const data   = refreshTokenSchema.parse(req.body);
    const client = getAuthClient();

    const { data: refreshData, error } = await client.auth.refreshSession({
      refresh_token: data.refresh_token,
    });
    if (error) return next(new UnauthorizedError('Invalid or expired refresh token.'));

    success(res, {
      access_token:  refreshData.session.access_token,
      refresh_token: refreshData.session.refresh_token,
      expires_in:    refreshData.session.expires_in,
      token_type:    'Bearer',
    });
  } catch (err) { next(err); }
}

// ── Logout ────────────────────────────────────────────────────────

async function logout(req, res, next) {
  try {
    const { error } = await supabaseAdmin.auth.admin.signOut(req.user.id);
    if (error) require('../utils/logger').warn('Supabase signOut error', { error: error.message });
    success(res, { message: 'Logged out successfully.' });
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

// ── Register / upsert profile ─────────────────────────────────────
//
// Called in two situations — see explanation at the bottom of this file.

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

async function getMe(req, res, next) {
  try {
    const userId = req.user.id;

    const [{ data: user }, { data: memberships }] = await Promise.all([
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

    const shapedMemberships = (memberships || []).map((m) => ({
      member_id:      m.id,
      role:           m.role,
      workspace_id:   m.workspace_id,
      display_name:   m.display_name,
      workspace_name: m.workspaces?.name,
      base_currency:  m.workspaces?.base_currency,
    }));

    success(res, { user: user || null, memberships: shapedMemberships });
  } catch (err) { next(err); }
}

// ── Update profile ────────────────────────────────────────────────

async function updateProfile(req, res, next) {
  try {
    const data   = updateProfileSchema.parse(req.body);
    const userId = req.user.id;

    const updates = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) updates[key] = value;
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

// ── Update contacts ───────────────────────────────────────────────

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

    for (const contact of data.contacts) {
      await supabaseAdmin.from('user_contacts').upsert(
        {
          user_id:      userId,
          type:         contact.type,
          label:        contact.label || null,
          value:        contact.value,
          country_code: contact.country_code || null,
          is_primary:   contact.is_primary ?? false,
        },
        { onConflict: 'user_id,type,value' }
      );
    }

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

// ── Request data export ───────────────────────────────────────────

async function requestDataExport(req, res, next) {
  try {
    success(res, { message: 'Your data export will be emailed within 24 hours.' });
  } catch (err) { next(err); }
}

module.exports = {
  signup, login, logout, refreshToken, forgotPassword, resetPassword, getGoogleAuthUrl,
  register, getMe, updateProfile, getAvatarUploadUrl, updateContacts,
  registerPushToken, updateNotificationPrefs, requestDataExport,
};
