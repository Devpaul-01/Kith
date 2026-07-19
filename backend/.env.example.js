# ── Server ──────────────────────────────────────────────────────────
NODE_ENV=development
PORT=3000
API_BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
LOG_LEVEL=info

# ── Supabase (required) ─────────────────────────────────────────────
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=

# ── Redis (required — BullMQ, rate limiting, caching) ───────────────
REDIS_URL=redis://localhost:6379

# ── Storage ──────────────────────────────────────────────────────────
STORAGE_BUCKET_NAME=kith-files

# ── Email (Resend) ──────────────────────────────────────────────────
RESEND_API_KEY=
EMAIL_FROM=Kith <noreply@kith.app>

# ── Push notifications (Firebase Admin) ─────────────────────────────
# Paste the full service-account JSON as a single-line string.
FIREBASE_SERVICE_ACCOUNT=

# ── OAuth / redirects ────────────────────────────────────────────────
# Comma-separated allowed deep-link schemes for mobile OAuth redirects.
ALLOWED_DEEPLINK_SCHEMES=kith://

# ── Feature toggles (default to enabled; set "false" to disable) ────
IDEMPOTENCY_ENABLED=true
FILE_VERIFICATION_ENABLED=true

# ── Bull Board (queue monitor at /admin/queues) ─────────────────────
# Leave both blank to disable Bull Board entirely.
BULL_BOARD_USERNAME=
BULL_BOARD_PASSWORD=
ADMIN_IP_WHITELIST=127.0.0.1,::1

# ── Error reporting (optional) ───────────────────────────────────────
SENTRY_DSN=
