// src/config/supabase.js
const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabaseUrl      = process.env.SUPABASE_URL;
const serviceRoleKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey          = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  logger.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (!anonKey) {
  logger.warn('SUPABASE_ANON_KEY not set — auth endpoints (login, signup) will not work');
}

// ── Service-role client (admin) ────────────────────────────────────
// Bypasses RLS. NEVER expose this key to clients.
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  db:   { schema: 'public' },
});

// ── Anon client ────────────────────────────────────────────────────
// Safe for user-facing auth operations (signIn, signUp, resetPassword).
const supabaseAuth = anonKey
  ? createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Backward-compat alias
const supabase = supabaseAdmin;

module.exports = { supabase, supabaseAdmin, supabaseAuth };
