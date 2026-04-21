// src/validators/auth.validator.js
const { z } = require('zod');

const SUPPORTED_CURRENCIES = [
  'GBP','USD','CAD','EUR','NGN','KES','GHS','INR','ZAR',
  'JPY','AUD','CHF','CNY','MXN','BRL','SGD','AED','SAR','ZMW',
];

// ── Signup (email + password — creates Supabase auth user) ────────
const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password too long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  full_name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  country_of_residence: z.string().min(2).max(100),
});

// ── Login (email + password) ─────────────────────────────────────
const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// ── Register profile (called after ANY auth method with a JWT) ────
// full_name is optional here because Google OAuth users auto-populate
// it from their Google profile. Email/password users have it from signup.
const registerSchema = z.object({
  full_name: z.string().min(2).max(100).optional(),
  country_of_residence: z.string().min(2).max(100).optional(),
});

// ── Forgot password ───────────────────────────────────────────────
const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

// ── Reset password (requires auth — recovery JWT) ─────────────────
const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password too long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

// ── Profile update ────────────────────────────────────────────────


const updateProfileSchema = z.object({
  full_name: z.string().min(2).max(100).optional(),
  bio: z.string().max(500).optional(),
  country_of_residence: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  avatar_url: z.string().url().optional(),
  push_enabled: z.boolean().optional(),
  email_digest_enabled: z.boolean().optional(),
  preferred_language: z.string().max(10).optional(),
});

// ── Contact methods ───────────────────────────────────────────────
const contactSchema = z.object({
  contacts: z.array(
    z.object({
      type: z.enum([
        'email_secondary','whatsapp','phone','telegram',
        'signal','instagram','facebook','twitter','linkedin','custom',
      ]),
      value: z.string().min(1).max(200),
      label: z.string().max(80).optional(),
      country_code: z.string().max(10).optional(),
      is_primary: z.boolean().optional().default(false),
    })
  ).min(1),
});

// ── Push token ────────────────────────────────────────────────────
const pushTokenSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(['web', 'ios', 'android']),
});

// ── Notification preferences ──────────────────────────────────────
const notificationPrefsSchema = z.object({
  push_enabled: z.boolean().optional(),
  email_digest_enabled: z.boolean().optional(),
});

// ── Token refresh ─────────────────────────────────────────────────
const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token is required'),
});

module.exports = {
  signupSchema,
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  contactSchema,
  pushTokenSchema,
  notificationPrefsSchema,
  refreshTokenSchema,
  SUPPORTED_CURRENCIES,
};
