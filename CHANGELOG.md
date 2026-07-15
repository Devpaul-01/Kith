# Changelog

This file records the history of notable fixes and changes to the Kith
backend. Inline code comments should describe *current* behavior and *why*
it's implemented the way it is — not a diff against some previous version.
That history lives here instead.

Entries are grouped by when they landed. Earlier entries (numbered "Issue N")
predate this changelog and were previously recorded as permanent inline
`// Issue N fix: ...` comments scattered across the codebase; those comments
have been trimmed down to short, forward-looking rationale (or removed
where the code was already self-explanatory) and their history moved here.

---

## Production hardening pass (this engagement)

Full findings in the accompanying engineering audit
(`01-audit-critical-high.md`, `02-audit-medium-low.md`,
`03-audit-verdict-roadmap.md`). Delivered in three batches, roughly
matching severity:

### Critical
- **C1** — Data export worker queried `ledger_entries.contributor_id` using
  a `users.id` instead of resolving `workspace_members.id` first; every
  export's ledger CSV was silently empty. Fixed by resolving member ids
  up front (matching how the task-export query in the same function
  already did it).
- **C2** — Google OAuth's `redirect_to` query param was reflected into the
  Supabase `/authorize` URL with no validation (open redirect). Now
  restricted to `FRONTEND_URL` or an explicit `ALLOWED_DEEPLINK_SCHEMES`
  allowlist.
- **C3** — Rate limiting used the default in-memory store, making it
  per-process rather than shared across horizontally-scaled instances. Now
  backed by Redis via `rate-limit-redis`.
- **C4** — Invite acceptance had a check-then-act race: two concurrent
  requests with the same token could both pass the `used_at` check. Fixed
  with an atomic conditional `UPDATE ... WHERE used_at IS NULL`.
- **C5** — Dead no-op `update()` call in the notification delivery worker
  (a leftover from an incomplete refactor), removed.
- **C6** — Several `count`-based safety guards (delete-container,
  delete-member, remove-participant) ignored query errors, silently
  failing open instead of closed. All now check `error` explicitly.

### High
- **H1** — `setTarget`'s supersede/insert/link sequence wasn't
  transactional; now a single atomic RPC
  (`set_contributor_target_atomic`, see `migrations/0002_*.sql`).
- **H2** — `/auth/reset-password` accepted any valid session token, not
  just a genuine recovery-link token. Split into a recovery-only
  `/auth/reset-password` (verified via JWT `amr` claim) and a new
  `/auth/change-password` (requires current password) for logged-in users.
- **H4** — Rate limiter now keys by authenticated user id where available,
  not just IP.
- **H5** — Bull Board's admin guard now does exact/CIDR IP matching
  (previously a substring match) and constant-time credential comparison.
- **H6** — Verified (no change needed): `generatePublicToken`/`generateToken`
  use `crypto.randomBytes` with adequate length.
- **H7** — `last_seen_at` was written to the DB on every authenticated
  request; now debounced to once per 5-minute window per user.

### Medium (selected — see audit doc for full list)
- **M1** — `getMemberEngagement` duplicated (and didn't share) the N+1 fix
  already correctly implemented in the engagement-check background worker;
  extracted into a shared `services/engagement.service.js`.
- **M2** — `utils/pagination.js`/`utils/response.js` had unused helpers
  (`getPagination`, `paginate`, `created`). `getPagination`/`paginate` are
  now wired into every paginated list endpoint; `buildOrderBy`/`created`
  were removed as genuinely unused and, in `buildOrderBy`'s case,
  incompatible with how this codebase actually queries (supabase-js
  builder, not raw SQL).
- **M3** — Audit action strings were duplicated across ~10 files with a
  separately hand-maintained description map. Consolidated into
  `constants/audit-actions.js`.
- **M4** — N+1 write loops in `addParticipants`, `addParticipantsFromGroup`,
  `createGroup`, `addGroupMembers` replaced with batch upserts.
- **M5** — `addCorrection` now requires the source entry to be `confirmed`.
- **M6** — `dispute_resolved` notifications previously always sent an
  empty container name; now populated via a join.
- **M7** — `updateWorkspace` now has an explicit field whitelist, matching
  every other update handler.
- **M8** — Unified `family_type` enum between create/update workspace
  schemas (previously diverged).
- **M9** — `payment_method` now rejects unrecognized values instead of
  silently coercing them to `"other"`.
- **M10** — Fixed a validation message that claimed a 10-character minimum
  while the actual constraint was 5.
- **M11** — Timeline pagination (containers + milestones merged) now uses
  a per-source cursor instead of one shared cursor, closing a real skip
  bug when the two sources have an uneven split across a page boundary.
- **M12** — Notification email HTML now escapes interpolated variables
  (container/task names, announcement text).
- **M13** — Uploaded files are now verified against their declared
  content-type (magic-byte check) at the existing "confirm" step of each
  upload flow (ledger proofs, task proofs, milestone photos).
- **M14** — `requireMembership` middleware's two independent queries now
  run in parallel.
- **M15** — Deduplicated audit-log filter-building logic between the
  paginated view and CSV export.
- **M16** — Idempotency-key checking is now gated by an explicit
  `IDEMPOTENCY_ENABLED` flag instead of silently swallowing all errors
  while probing for a possibly-missing column.
- **M17** — *(pending schema)* `updateContacts` remains a two-step,
  non-atomic write; needs the same RPC treatment as H1 once the real
  `user_contacts` schema is available.

### Low
- **L1** — Removed numbered `console.log` bootstrap tracing from the
  worker process entry point.
- **L2** — Removed the unreachable `|| '*'` CORS origin fallback.
- **L3** — Documented (no behavior change) why invite preview
  intentionally returns HTTP 200 for all failure reasons.
- **L4** — `getDispute`'s ledger-entry lookup now uses `.maybeSingle()` +
  `NotFoundError` instead of `.single()`'s raw Postgrest error.
- **L5** — `mapSupabaseAuthError` now prefers `error.code` over
  message-substring matching, with message matching kept as a fallback.
- **L6** — Unified the two independent CSV-building implementations in
  task export (admin vs. member path) into one shared, parameterized
  function.
- **L7** — Workspace search now escapes `%`/`_` ILIKE wildcards.
- **L8** — Documented (no behavior change) the assumption that OAuth CSRF
  `state` handling is delegated to Supabase's GoTrue.
- **L9** — Explicit helmet configuration (HSTS, frameguard, referrer
  policy) instead of implicit defaults.
- **L10** — Explicit `keepAliveTimeout`/`headersTimeout` on the HTTP
  server.

### Also found during this pass (not in the original audit)
- The `notification-outbox-queue` worker (`createNotificationOutboxWorker`)
  was exported and had a cron schedule registered, but was never actually
  instantiated in the worker bootstrap (`workers/index.js`) — the
  scheduled job fired every 5 minutes with nothing listening on the queue.
  Now wired in.
- A dead ternary (`x ? y : y`) introduced (and caught) during the M4
  refactor of `addGroupMembers`, before it shipped.

---

## Pre-existing fixes (recorded here from prior inline "Issue N" comments)

- **Issue 1** — Refresh-token cookie path corrected from `/api/auth/refresh`
  to `/v1/auth/refresh` (login, refresh, Google callback, logout).
- **Issue 2** — Removed a dead-code duplicate definition of `getMe`.
- **Issue 3** — `resolveMember` (notification routes) throws `NotFoundError`
  on no active membership instead of silently proceeding with a null id.
- **Issue 4** — `deleteContact` now returns 404 for a non-existent
  `contactId` instead of a false-positive 200.
- **Issue 5** — Multi-step writes (dispute raise/resolve, event→recurring
  conversion) replaced with atomic RPCs to remove TOCTOU races.
- **Issue 5.1**–**5.10** — Added several previously-missing endpoints and
  route orderings: single ledger-entry fetch, delete pending ledger entry,
  ledger summary aggregate, single milestone fetch, delete ledger/task
  proof by index, cross-entity workspace search.
- **Issue 6** — `loadDbUser` uses an explicit column list instead of
  `select('*')`.
- **Issue 7** — `getMe` reuses `req.dbUser` from `loadDbUser` instead of
  an extra query.
- **Issue 8** — Removed references to a non-existent `plan` column on
  `workspaces`.
- **Issue 9** — Confirmed (no change) that `listContainers`'s
  `ledger_entries` join was already correct.
- **Issue 10** — Added `GET /workspaces/:id/search` (cross-entity search).
- **Issue 12** — `updateContacts` uses a single batch upsert instead of a
  sequential per-contact loop.
- **Issue 13** — `upsertContact` uses an atomic RPC
  (`upsert_primary_contact`) instead of two sequential writes.
- **Issue 15** — Self-or-admin authorization for member updates moved from
  the controller to route-level middleware (`requireSelfOrAdmin`).
- **Issue 16** — `overrideTaskStatus` restricted to admins at the route
  level.
- **Issue 19** — Admin announcement validation moved into a Zod schema.
- **Issue 21** — Implemented GDPR data export (was a no-op stub): queues
  a job, worker generates and emails CSVs.
- **Issue 22** — Removed a leftover debug `console.log` from the task
  proof-upload-URL handler.
