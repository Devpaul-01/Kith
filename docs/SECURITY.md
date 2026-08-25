# Security Policy — Kith Backend

This document describes the security architecture of the Kith backend (`kith-backend`), a Node.js/Express API backed by Supabase (Postgres + Auth), Redis, and BullMQ. Design tradeoffs are documented explicitly rather than glossed over. A consolidated, at-a-glance table of these same mechanisms is also in [ARCHITECTURE.md §18](ARCHITECTURE.md#18-security-architecture).

---

## 1. Security Overview

Kith's security model is built around three layers:

1. **Perimeter** — Helmet security headers, strict CORS, IP- and user-scoped Redis rate limiting, and a 1MB request body cap, applied globally in `app.js` before any route is reached.
2. **Identity & Access** — Supabase-issued JWTs verified on every authenticated request (`middleware/auth.js`), followed by a workspace-membership check that resolves role and scoping (`middleware/workspace.js`), followed by route-level role gates (`middleware/role.js`).
3. **Data Integrity** — All persistence goes through the Supabase JS client (parameterized queries, no raw SQL string concatenation anywhere in the codebase), with multi-step state transitions wrapped in Postgres RPCs to guarantee atomicity where a race condition would otherwise be exploitable (e.g. invite acceptance, dispute resolution, contributor target changes).

The guiding principle throughout the codebase is **fail closed, fail loud**: guards that can't verify a precondition throw rather than silently proceeding, and errors surface as explicit typed exceptions (`utils/errors.js`) rather than falling through to default-allow behavior.

This is a portfolio project demonstrating production-grade backend security practices, not a live service handling real user financial data at scale. Section 13 documents where that context shapes design tradeoffs.

---

## 2. Supported Versions

This is a single-track portfolio project with no parallel maintained release branches.

| Component | Status |
|---|---|
| `main` / latest commit | Actively maintained — receives security fixes |
| Prior commits/tags | Not maintained — no backports |

There is no LTS branch and no formal versioning scheme (`package.json` is pinned at `1.0.0`). Anyone evaluating or forking this code should assume only the current `HEAD` reflects the security posture described here.

---

## 3. Reporting Vulnerabilities

This project does not currently have a dedicated security contact address, bug bounty program, or `security@` inbox — it is a personal portfolio project rather than an organization with a security team.

If you find a vulnerability:

1. **Do not open a public GitHub issue** describing the exploit.
2. Contact the maintainer privately via the contact details on the GitHub profile hosting this repository (or via the email associated with the repository's commits).
3. Include: affected file/endpoint, reproduction steps, and potential impact.
4. Allow reasonable time for a fix before any public disclosure.

Since this project has no production deployment with real user data, the practical urgency of most findings will be "this pattern would be dangerous if deployed live" rather than "this is currently being exploited" — but responsible, private disclosure is still the expected norm.

---

## 4. Authentication

**Provider:** Supabase Auth (GoTrue) is the sole identity provider. This backend never stores or hashes passwords itself — `supabaseAuth.auth.signUp` / `signInWithPassword` / `admin.updateUserById` delegate all credential handling to Supabase (`services/auth.service.js`).

### Login flow
- `POST /v1/auth/login` calls `supabaseAuth.auth.signInWithPassword`. On success, an `access_token` (JWT) and `refresh_token` are issued. The refresh token is set as an `httpOnly`, `secure` (in production), `sameSite=strict` cookie scoped to `/v1/auth/refresh`; the access token is returned in the JSON body for the client to hold in memory/short-lived storage (`auth.controller.js`, `REFRESH_COOKIE_OPTS`).

### Token validation
- Every authenticated request passes through `requireAuth` (`middleware/auth.js`), which calls `supabaseAdmin.auth.getUser(token)` to verify the JWT against Supabase on every request (not just signature-checked locally). A missing/malformed `Authorization: Bearer` header or an invalid/expired token yields `401 UNAUTHORIZED`.
- `loadDbUser` additionally loads a fixed, explicit column set from `users` (never `select('*')`) and rejects soft-deleted accounts (`deleted_at IS NOT NULL`).

### Session handling / refresh
- `POST /v1/auth/refresh` exchanges the `refresh_token` cookie for a new access/refresh token pair via `supabaseAuth.auth.refreshSession`. Refresh tokens are rotated on every use and re-set as the httpOnly cookie.
- `POST /v1/auth/logout` and `/logout-all-devices` call Supabase's `admin.signOut(userId)` / `admin.signOut(userId, 'global')` and clear the refresh cookie.

### Password policy
- Enforced via Zod at the API boundary (`validators/auth.validator.js`): minimum 8 characters, max 72 (bcrypt's practical limit), must contain at least one uppercase letter and one digit.
- **Change password** (`/v1/auth/change-password`) requires re-authentication with the *current* password (a real `signInWithPassword` call) before Supabase's admin API is used to set the new one — this specifically prevents an attacker holding a stolen-but-valid access token from locking the real owner out.
- **Reset password** (`/v1/auth/reset-password`) is gated to the Supabase password-recovery flow specifically: the JWT's `amr` (Authentication Methods Reference) claim is decoded and checked for a `recovery` entry (`isRecoverySession()`), so a normal logged-in session's access token cannot be used to hit this endpoint — only a token minted by clicking the emailed recovery link can.

### OAuth
- Google OAuth is implemented (`GET /v1/auth/google/url`, `POST /v1/auth/google/callback`) via Supabase's `/authorize` endpoint and `exchangeCodeForSession`.
- **Open-redirect protection:** the `redirect_to` parameter is validated against the configured `FRONTEND_URL` origin or an explicit `ALLOWED_DEEPLINK_SCHEMES` allowlist before being honored (`isAllowedGoogleRedirect()`); anything else silently falls back to the default redirect and is logged as rejected.
- OAuth `state` parameter handling is delegated entirely to Supabase GoTrue — this app does not independently set or validate its own `state` value (see Section 13).

### Email verification
- `POST /v1/auth/verify-email` exchanges a Supabase OTP token hash for a session via `verifyOtp`.

### Rate limiting on auth endpoints
- Signup, login, refresh, forgot-password, and OAuth callback are all behind `authLimiter`: 5 requests/minute per IP (`middleware/rateLimiter.js`), backed by Redis so the limit is shared across all instances rather than per-process.

---

## 5. Authorization

### Role-based access
Two roles exist within a workspace: `admin` and `member`. `middleware/role.js` provides:
- `requireAdmin` — 403s any non-admin caller. Must run after `requireMembership`.
- `requireSelfOrAdmin(getMemberId)` — allows the resource owner or any admin (used on `PATCH /members/:memberId` so a member can edit their own profile without being able to edit anyone else's).

### Workspace isolation
- `requireMembership` (`middleware/workspace.js`) is mounted on *every* route under `/v1/workspaces/:workspaceId` (`routes/workspace.routes.js`, `router.use(requireAuth, loadDbUser, requireMembership, userGeneralLimiter)`). It verifies the caller has an active, non-deleted `workspace_members` row for that specific workspace before any handler runs.
- **Enumeration resistance:** a non-member requesting a workspace that exists gets the same `404 NotFoundError` as a workspace that doesn't exist — the middleware never returns `403` for membership failures, specifically to avoid leaking which workspace IDs are valid.
- UUID-shape validation on `:workspaceId` happens before any DB query, rejecting malformed IDs early.
- A short-lived (30s) Redis cache of `{ member, workspace }` reduces DB load on this hot-path check; any write to a member's `role`, `is_active`, `is_proxy`, or `proxy_managed_by` triggers immediate cache invalidation (`services/membership-cache.service.js`, `member.service.js`), and workspace deletion invalidates every cached membership for that workspace via Redis `SCAN`.

### Ownership validation
- Ledger entries, tasks, and disputes consistently check `resource.contributor_id === req.member.id` (or `assigned_to`, or `raised_by`) before allowing a non-admin to read or mutate them — enforced at the service layer in `ledger.service.js`, `task.service.js`, and `dispute.service.js`, not just the route layer, so a service function called from a different context can't skip the check.
- Proxy members (dependents managed by another member) can only have ledger entries recorded on their behalf by an admin (`ledger.service.js`: `if (member?.is_proxy && !isAdmin) throw ForbiddenError`).

### Admin-only operations
Enforced via `requireAdmin` at the route layer for: workspace settings/deletion, member creation/role changes/removal, group management, container creation/lifecycle, invite creation/revocation, dispute listing/resolution, task status overrides and admin-confirmation, ledger entry confirmation and corrections, and audit log access.

### Last-admin protection
`member.service.js` blocks both self-demotion and self-removal of the sole remaining admin in a workspace (`Cannot demote the last admin`, `Cannot remove the last admin`), preventing workspaces from being locked into a state with no admin.

### Optimistic locking
`updateMember` supports an optional `version` field (the record's `updated_at`) and rejects the update with a `BusinessRuleError` if it doesn't match, protecting against lost-update races on concurrent profile edits.

---

## 6. API Security

### Input validation
Every mutating endpoint validates its body against a Zod schema before touching the database (`validators/*.js`). Validation failures return a structured `400 VALIDATION_FAILED` with per-field messages (`middleware/errorHandler.js`). Notable specifics:
- `payment_method` is validated against an explicit synonym map and *rejects* unrecognized values rather than silently coercing them to `'other'`.
- UUID fields are validated with `z.string().uuid()` throughout, closing off id-shaped injection/enumeration attempts at the schema layer before they reach a query.

### Output sanitization
- HTML emails (`notification_delivery.service.js`, `data_export.service.js`) run all interpolated user-controlled strings (titles, names, container names) through a manual `escapeHtml()` before building the HTML body, preventing stored-XSS-via-email for values that originate from user input (e.g. an admin announcement title).
- API JSON responses are not further sanitized — the API is not itself an HTML-rendering surface, so this is a deliberate boundary (the client is responsible for escaping on render).

### Rate limiting
Redis-backed (`rate-limit-redis` + `ioredis`), so limits are enforced fleet-wide, not per-instance (`middleware/rateLimiter.js`):

| Limiter | Scope | Limit | Applies to |
|---|---|---|---|
| `authLimiter` | Per IP | 5/min | signup, login, refresh, forgot-password, Google callback |
| `inviteLimiter` | Per user | 10/hour | invite acceptance |
| `uploadLimiter` | Per user | 20/hour | signed upload-URL generation |
| `publicLookupLimiter` | Per IP | 30/min | unauthenticated invite preview & public container view (anti-enumeration) |
| `generalLimiter` | Per IP | 200/min | every request, pre-auth baseline |
| `userGeneralLimiter` | Per user | 200/min | every workspace-scoped request, post-auth |

The general limiter is deliberately split into a pre-auth IP-keyed limiter and a post-auth user-keyed limiter, so that per-user throttling only ever applies once an authenticated identity actually exists in the request — see ADR-0006 for the full reasoning.

### CORS
`cors()` is configured with a single explicit `origin: process.env.FRONTEND_URL` (no wildcard fallback — the app refuses to boot without this variable set, per `server.js`'s `validateEnvironment()`), `credentials: true`, and an explicit method/header allowlist (`app.js`).

### HTTP security headers
`helmet()` is applied with explicit overrides: HSTS (`max-age=31536000`, `includeSubDomains`), `frameguard: deny` (clickjacking protection), and `referrerPolicy: no-referrer`. The default CSP is left at Helmet's baseline rather than a hand-tuned policy — a deliberate tradeoff because the same Express process also serves the Bull Board admin UI, and an aggressive API-tuned CSP could break Bull Board's asset loading.

### Request size limits
`express.json({ limit: '1mb' })` caps request body size globally.

### Secure error responses
`middleware/errorHandler.js` distinguishes known application errors (typed subclasses of `AppError`, returned with their real message/code) from unexpected errors, which return a generic `"An internal error occurred"` in production (`NODE_ENV === 'production'`) while still logging the full message and stack server-side. Postgres unique-violation (`23505`) and foreign-key-violation (`23503`) codes are mapped to clean `409`/`422` responses rather than leaking raw Postgres error text.

### CSRF
There is no separate CSRF token mechanism. The refresh token — the only credential held in a cookie — is `sameSite: strict`, which prevents it from being sent on cross-site requests in the first place; the access token used for all other authenticated calls is a Bearer token supplied explicitly in an `Authorization` header by the client, which is not automatically attachable by a third-party site. This combination is a reasonable substitute for explicit CSRF tokens given the API's Bearer-token-primary design, but is **not** a drop-in replacement if the API ever starts accepting the access token via cookie as well.

### WebSockets
None. The application is exclusively a REST/JSON API; there is no WebSocket server or real-time push channel in the codebase.

---

## 7. Database Security

- **No raw SQL anywhere.** All data access goes through the Supabase JS client (`@supabase/supabase-js`), whose query builder (`.eq()`, `.ilike()`, `.select()`, etc.) parameterizes values under the hood — there is no string-concatenated SQL in the codebase.
- **ILIKE wildcard escaping:** free-text search (`search.service.js`) and member-name search (`member.service.js`) both escape `%`, `_`, and `\` in user input before embedding it in an `ILIKE` pattern (`utils/ilike.js`), preventing a user from injecting their own wildcards to broaden/narrow a search beyond what was intended.
- **Service-role key usage:** `supabaseAdmin` (service-role, bypasses Row-Level Security) is used for essentially all application queries; a separate `supabaseAuth` client using the anon key is reserved specifically for user-facing auth flows (signup/login/password-reset) where Supabase's own auth semantics apply. Because the service-role client bypasses RLS, **all authorization is enforced in the application layer** (middleware + service-level ownership checks documented in Section 5) — RLS is not a backstop here. This is a significant architectural fact for anyone extending the codebase: a new query added to `supabaseAdmin` without an accompanying ownership/membership check has no database-level safety net.
- **Atomic multi-step operations** are pushed into Postgres RPCs rather than sequential JS calls, closing race-condition windows that plain check-then-write JS code would otherwise have: `raise_dispute_atomic`, `resolve_dispute_atomic`, `set_contributor_target_atomic`, `convert_event_to_recurring_atomic`, `create_workspace_with_admin`, `upsert_primary_contact`, `replace_user_contacts_atomic`. Invite acceptance uses a single conditional `UPDATE ... WHERE used_at IS NULL` to atomically claim an invite, closing a double-accept race.
- **Soft deletes** (`deleted_at`) are used consistently for workspaces, members, containers, and milestones, and every read query that should exclude deleted rows explicitly filters `.is('deleted_at', null)`.
- **Idempotency:** ledger entry creation supports an `X-Idempotency-Key` header; a repeated request with the same key against the same workspace returns the original entry rather than creating a duplicate (`ledger.service.js`). A separate time-window duplicate-detection heuristic (same contributor/amount within 10 minutes) also guards against accidental double-submission when no idempotency key is supplied, and can be bypassed explicitly with `?force=true`.
- **Fail-closed count guards:** operations that check "are there any confirmed ledger entries before allowing this destructive/state-changing action" (disabling money tracking, deleting a container, removing a participant/member) explicitly check the query's `error` field and throw rather than proceeding on a failed count query defaulting to `0`.

### Redis security
- Redis is used for: BullMQ job queues, rate-limit counters (`rate-limit-redis`), the membership cache, and a debounce lock for `last_seen_at` writes.
- Connection is via `REDIS_URL` (expected to include auth/TLS if the deployment target requires it — this app does not itself enforce TLS on the Redis connection; that's a deployment-environment concern).
- Every Redis-dependent code path is written to **fail open safely**: if Redis is unreachable, rate limiting falls back to an in-memory store (logged as a warning), the membership cache falls back to a live DB query, and the `last_seen_at` debounce simply skips the write for that request. None of these failure modes weaken authorization — they only affect performance/optimization paths.

---

## 8. File Upload Security

Files (ledger proofs, task proofs, milestone photos, avatars, workspace avatars, container cover photos/outcome files) are uploaded **directly from the client to Supabase Storage** using short-lived signed upload URLs generated by this API (`services/storage.service.js`) — the Express process never proxies raw file bytes for the initial upload.

### Validation at URL-issuance time
- `validateUpload()` checks the *declared* `content_type` against an explicit per-file-type allowlist (e.g. proofs allow images + PDF; avatars allow images only) and enforces a per-type max size (5MB–50MB depending on type).

### Validation at confirm time (post-upload)
Because client-declared `content_type` can be spoofed, every upload flow has a mandatory "confirm" step that runs **after** the file lands in storage and **before** it's trusted (attached to a ledger entry, task, or milestone):
- `verifyUploadedFile()` downloads the file and checks its actual byte signature (magic bytes) against the declared content type — e.g. JPEG must start with `FF D8 FF`, PNG with the standard 8-byte PNG signature, PDF with `%PDF`, WEBP's `RIFF....WEBP` container is checked at the correct offset. A mismatch throws `BusinessRuleError` and the file is never attached to any record.
- This guards against a mislabeled file (e.g. an HTML file declared as `image/jpeg`) being stored and later served back with an image content-type.
- Verification can be disabled via `FILE_VERIFICATION_ENABLED=false` but defaults to **enabled**, since it's treated as a security control rather than an optional convenience.

### Filename handling
Uploaded filenames are never used as-is for storage paths — `generateUploadUrl()` derives a randomized filename (`${Date.now()}-${random}.${ext}`) and only trusts the client-supplied extension for the file suffix, preventing path traversal or filename-collision attacks via a malicious original filename.

### Current scope
- **No malware/antivirus scanning.** Magic-byte verification confirms a file's *container format* matches its declared type; it does not scan file contents for embedded malicious payloads (e.g. a well-formed PDF with a malicious embedded script, or an image with polyglot content). A content-scanning layer is a natural addition on top of this — see Section 14.
- Deletion (`storage_service.deleteFile`) exists as an explicit action; there is no automated orphan-cleanup job for files whose parent record was deleted without an explicit `deleteProof`/similar call.

---

## 9. Secrets Management

All secrets are supplied via environment variables and loaded through `dotenv` at process start (`server.js`, `start-all.js`, `workers/index.js`). No secret is hardcoded anywhere in the codebase.

**Required at boot** (`validateEnvironment()` in `server.js`/`start-all.js`, hard `process.exit(1)` if missing):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `FRONTEND_URL`

**Used elsewhere, with graceful degradation if absent** (logged as a warning, feature disabled rather than a crash):
- `SUPABASE_ANON_KEY` — auth endpoints disabled without it
- `RESEND_API_KEY` — email notifications disabled
- `FIREBASE_SERVICE_ACCOUNT` — push notifications disabled
- `SENTRY_DSN` — error tracking simply not initialized
- `BULL_BOARD_USERNAME` / `BULL_BOARD_PASSWORD` — the admin queue dashboard route is not mounted at all if either is missing

**Handling practices observed:**
- The service-role Supabase key (`SUPABASE_SERVICE_ROLE_KEY`), which bypasses Row-Level Security, is only ever read into `config/supabase.js` and never logged, echoed in an error message, or exposed in any API response.
- Bull Board Basic Auth credentials are compared using `crypto.timingSafeEqual` (with an explicit length-check guard, since `timingSafeEqual` throws rather than returning `false` on mismatched buffer lengths) instead of `===`, closing a timing side-channel against the admin dashboard password.
- `.env` files are expected to be excluded from version control (standard Node.js convention); this repository does not commit one.

**What this document does not and cannot verify:** actual secret *values*, rotation cadence, or the deployment platform's secret-storage mechanism (e.g. whether `REDIS_URL`/`SUPABASE_SERVICE_ROLE_KEY` are stored in a proper secrets manager vs. plaintext deployment config) — that is infrastructure outside this repository's scope.

---

## 10. External Services

| Service | Role | Security-relevant notes |
|---|---|---|
| **Supabase** (Postgres + Auth + Storage) | Primary datastore, identity provider, file storage | Service-role key bypasses RLS — app-layer authorization is the real enforcement boundary (Section 7). Auth (password hashing, JWT issuance, OAuth) is fully delegated to Supabase GoTrue. |
| **Redis** | BullMQ queues, rate limiting, membership cache, last-seen debounce | Connection string via `REDIS_URL`; TLS/auth is a deployment-time configuration, not enforced by app code. All Redis failure modes fail open to safe (slower, not less-secure) fallbacks. |
| **Resend** | Transactional email (password reset, data export delivery, notification emails) | HTML bodies escape user-controlled interpolated values (Section 6). API key gates whether the client initializes at all. |
| **Firebase Cloud Messaging** | Push notification delivery | Service account JSON supplied via `FIREBASE_SERVICE_ACCOUNT` env var; push token rotation is checked at delivery time (`notification_delivery.service.js` re-verifies the stored token still matches what was queued before sending, to avoid delivering to a stale/rotated token). |
| **Sentry** | Error tracking | Only initialized if `SENTRY_DSN` is set; `tracesSampleRate: 0.1`. |
| **Bull Board** | Internal queue-monitoring dashboard | Not a "third party" but worth flagging: only mounted if Basic Auth credentials are configured, additionally gated by an IP allowlist (`ADMIN_IP_WHITELIST`, exact-match or IPv4 CIDR) with timing-safe credential comparison. |

No AI/LLM provider integration exists in this backend.

---

## 11. Logging & Monitoring

### Structured logging
Winston (`utils/logger.js`) with environment-aware formatting: colorized human-readable logs in development, JSON in production (suitable for ingestion by a log aggregator). Uncaught exceptions and unhandled promise rejections are captured by dedicated Winston handlers as well as explicit `process.on()` listeners in `server.js`/`start-all.js`/`workers/index.js` that log and then exit (for uncaught exceptions) or log-and-continue (for unhandled rejections, since a single rejected background promise shouldn't take down the whole process).

### Request logging
`middleware/requestLogger.js` logs every request on `res.on('finish')` with method, path, status, duration, and — when available — `user_id`, `workspace_id`, `workspace_member_id`. Log level is derived from status code (`error` for 5xx, `warn` for 4xx, `info` otherwise). Every request also gets a generated `X-Request-Id` (`requestId` middleware) that's threaded through subsequent logs for correlation, including the verbose login-flow tracing in `auth.service.js`.

### Audit logging
A dedicated, persistent audit trail (distinct from operational logs) is written to the `audit_log` table via `services/audit.service.js` for security/business-sensitive actions: container/workspace/group/member creation, deletion, and settings changes; ledger confirmations, corrections, and deletions; dispute raise/resolve; task creation/completion/confirmation; workspace announcements. Each entry captures actor (user + workspace-member id), action, target type/id, metadata, IP address, and user agent (`audit.fromReq(req)`). The audit log itself is fire-and-forget — a failure to write an audit row logs an error but does not fail the underlying request, a deliberate choice so audit-logging infrastructure issues can't become an availability problem for the core product.

Admins can query (`GET /workspaces/:id/audit-log`) and export (`GET /workspaces/:id/audit-log/export`, CSV) their workspace's audit trail, gated by `requireAdmin`. See [PRODUCT_OVERVIEW.md §21](PRODUCT_OVERVIEW.md#21-audit-log--activity-feed) for what the resulting activity feed looks like end-to-end.

### Sensitive data handling in logs
- Passwords are never logged (they never pass through this codebase at all — see Section 4).
- JWTs/access tokens/refresh tokens are not written to logs anywhere in the codebase.
- **No automated PII-redaction layer exists** for logs in general — see Section 13 for the associated caveat.

### Monitoring / alerting
Sentry integration exists for exception tracking (Section 10) but there is no separate alerting/paging system, uptime monitoring, or dashboard configured within this codebase — those would be operational/infrastructure concerns layered on top in a real deployment.

---

## 12. Security Best Practices Implemented

A consolidated checklist, covered in more detail in the sections above:

- [x] Authentication delegated to a dedicated identity provider (Supabase Auth) — no custom password hashing/storage
- [x] JWT verified against the issuer on every request (not just locally signature-checked)
- [x] httpOnly, secure (prod), sameSite=strict cookie for the refresh token
- [x] Current-password re-verification required before password change
- [x] Recovery-flow-specific JWT claim check (`amr: recovery`) on the password-reset endpoint
- [x] OAuth open-redirect protection via origin/scheme allowlist
- [x] Password complexity policy enforced at the validation layer
- [x] Role-based authorization (admin/member) enforced at route and service layers
- [x] Workspace-scoped membership check on every workspace route, with 404-not-403 enumeration resistance
- [x] Ownership checks (contributor/assignee/raiser) enforced in services, not just routes
- [x] Last-admin removal/demotion protection
- [x] Redis-backed, fleet-wide rate limiting, split by pre-auth (IP) vs. post-auth (user) scope
- [x] Tighter anti-enumeration rate limit on public lookup endpoints
- [x] Helmet security headers (HSTS, frameguard, referrer-policy)
- [x] Explicit CORS origin allowlist (no wildcard fallback)
- [x] Request body size cap (1MB)
- [x] Zod input validation on every mutating endpoint
- [x] HTML-escaping of user-controlled values interpolated into emails
- [x] No raw/string-concatenated SQL anywhere — Supabase query builder throughout
- [x] ILIKE wildcard-character escaping on all free-text search inputs
- [x] Atomic Postgres RPCs for every multi-step state transition with a race-condition risk
- [x] Idempotency-key support + time-window duplicate detection on financial writes
- [x] Signed, short-lived, direct-to-storage upload URLs (API never proxies file bytes)
- [x] Post-upload magic-byte verification against declared content-type before trusting any file
- [x] Randomized storage filenames (no user-controlled path segments)
- [x] Timing-safe credential comparison for Bull Board Basic Auth
- [x] IP allowlist (exact + CIDR) on the Bull Board admin dashboard
- [x] Environment variable validation at boot — hard fail on missing required secrets
- [x] Structured, correlatable request logging with generated request IDs
- [x] Persistent, queryable audit trail separate from operational logs
- [x] Graceful, fail-open degradation on Redis unavailability (never fail-open on *authorization*, only on caching/rate-limit optimizations)
- [x] Generic error messages to clients in production; full detail retained server-side only

---

## 13. Design Boundaries Worth Knowing

Documented honestly, since these are deliberate scope boundaries rather than oversights:

1. **Service-role Supabase client bypasses Row-Level Security.** All authorization is application-layer. RLS policies may or may not exist on the underlying tables, but this codebase does not depend on them and does not verify their presence. Any new `supabaseAdmin` query must be paired with the equivalent ownership/membership check, since there is no database-level safety net to catch a missing one.

2. **No malware/content scanning on uploaded files.** Magic-byte verification confirms container-format authenticity, not payload safety. A well-formed-but-malicious PDF or a genuinely valid image with a steganographically embedded payload would pass all current checks.

3. **No CSRF token scheme.** The design relies on `sameSite=strict` (for the one cookie that exists) plus Bearer-token-in-header (for everything else) as a substitute. This is reasonable for the current API shape but would need revisiting if cookie-based auth were ever extended beyond the refresh token.

4. **OAuth `state` parameter is not independently managed by this application** — it's delegated entirely to Supabase GoTrue's `/authorize` flow. This app does not add its own CSRF-style state verification on top.

5. **No centralized PII-redaction layer for logs.** Individual sensitive values (passwords, tokens) are deliberately never logged, but there's no generic scrubbing middleware — any future log statement would need to independently avoid logging a full user object.

6. **No 2FA / MFA.** Authentication is single-factor (password or Google OAuth) for every account, including admin accounts.

7. **No automated dependency vulnerability scanning configured in this repo** (e.g. no committed `npm audit`/Dependabot/Snyk config visible in `package.json` beyond standard `dependencies`).

8. **Redis transport security (TLS, AUTH) is a deployment-time responsibility**, not enforced or verified by the application code — `REDIS_URL` is trusted as given.

9. **The default Helmet CSP is not hand-tuned** for this specific API — deliberately, because Bull Board's HTML dashboard shares the same Express process and a strict API-tuned CSP risked breaking Bull Board's asset loading.

10. **Bounded staleness in the membership cache** (up to 30 seconds) for authorization-relevant fields (`role`, `is_active`). All in-application write paths correctly invalidate the cache immediately, so this window only matters for state changes made *outside* the application (e.g. a direct database edit) — an explicit, accepted tradeoff.

11. **This is a portfolio project, not a monitored production service.** There is no on-call rotation, no uptime SLA, and no live deployment handling real financial data. Treat the security posture described here as "what the code implements," not "what has been battle-tested under adversarial production traffic."

---

## 14. Security Roadmap

Planned additions, intended as future enhancements to an already-solid baseline rather than fixes to known problems:

- **Malware-scanning step** (e.g. ClamAV or a cloud AV API) for the file-upload confirm flow, alongside the existing magic-byte check.
- **MFA/2FA**, at minimum as an opt-in for admin-role workspace members, given they hold the highest-privilege actions (member removal, workspace deletion, ledger confirmation).
- **Automated dependency scanning** (Dependabot or `npm audit --audit-level=high` in CI) to catch known-vulnerable transitive dependencies proactively.
- **A hand-tuned Content-Security-Policy** once Bull Board is split onto a separate origin, rather than relying on Helmet's defaults for the whole process.
- **A generic log-scrubbing middleware** as defense-in-depth against accidental future logging of sensitive fields.
- **Formal RLS policies in Postgres** as a second authorization layer beneath the application layer, so a future application-layer change doesn't automatically become a full data-exposure risk.
- **Explicit Redis AUTH/TLS configuration guidance** in deployment documentation, since the app currently trusts `REDIS_URL` as given.
- **Content scanning / size-based anomaly detection** on the data-export and audit-log CSV export endpoints, which currently have no additional rate limiting beyond the general per-user limiter despite generating potentially large files.

---
