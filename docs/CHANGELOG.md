# Changelog

This changelog summarizes the notable engineering work behind the Kith
backend, organized by category rather than by release, since the project
does not follow a dated release cadence.

---

## Security

- **Bull Board admin dashboard IP allowlisting uses exact-match or real
  (IPv4-only) CIDR matching** rather than substring matching, so an
  allowlisted `1.2.3.4` cannot inadvertently match an unrelated IP like
  `21.2.3.40`.
- **Bull Board Basic Auth credentials are compared with
  `crypto.timingSafeEqual`**, a constant-time comparison that guards
  against a timing side-channel on the admin password, with an explicit
  length-mismatch guard since `timingSafeEqual` throws rather than
  returning `false` on mismatched buffer lengths.
- **`helmet()` is configured explicitly** (HSTS with `includeSubDomains`,
  deny framing, `no-referrer` policy), deliberately conservative since the
  same process also serves the Bull Board HTML dashboard under the same
  helmet instance.
- **CORS has no wildcard fallback for `FRONTEND_URL`.** Startup validation
  refuses to boot without it, and a wildcard origin combined with
  credentialed requests would be rejected by browsers anyway — removing
  the fallback keeps the failure mode explicit rather than silently
  breaking cookie-based auth.
- **File uploads (ledger proofs, task proofs, milestone photos) are
  validated against their actual uploaded bytes**, not just the
  client-declared `content_type` and `file_size`. `verifyUploadedFile()`
  checks magic-byte signatures against the declared type at each flow's
  "confirm" step, after the file lands in storage. Configurable via
  `FILE_VERIFICATION_ENABLED`.
- **`/auth/reset-password` only accepts a session established via the
  password-recovery link flow.** It checks the JWT's `amr`
  (Authentication Methods Reference) claim for a `recovery` entry, which
  Supabase includes specifically for that flow.
- **`/auth/change-password` verifies the caller's current password**
  before changing it, via a real sign-in attempt, so a stolen access token
  alone is never sufficient to lock the real account owner out.
- **Google OAuth `redirect_to` is restricted to an allowlist** — only
  honored if it starts with the app's own `FRONTEND_URL` origin or matches
  an explicitly configured mobile deep-link scheme.
- **Signup surfaces partial failure explicitly.** If the Supabase Auth
  user is created but the subsequent `users` table upsert fails, the
  response flags `profile_setup_required: true` rather than hiding the
  failure, prompting the client to call `/auth/register` to repair the
  state.
- **Unauthenticated lookup endpoints (invite preview, public container
  view) have a dedicated `publicLookupLimiter`** (30/min per IP), tuned
  specifically against token-space enumeration rather than relying on the
  general baseline alone.
- **ILIKE search patterns are escaped against wildcard injection.** Raw
  user input containing `%`, `_`, or `\` is escaped before being
  interpolated into a `%...%` pattern, via a shared
  `utils/ilike.js#containsPattern()` applied consistently across workspace
  search and member search.
- **`bank_details` (a sensitive jsonb column) is excluded from the
  `requireMembership` query**, since it has no consumer anywhere in the
  codebase — avoiding fetching a sensitive column into every single
  workspace-scoped request for no benefit.

## Reliability & Correctness

- **Rate limiting is split into a per-IP baseline and a genuinely per-user
  limiter.** `generalLimiter` is IP-keyed and mounted pre-auth as a
  baseline for all traffic; `userGeneralLimiter` is user-keyed and mounted
  after `requireAuth` on authenticated route trees — each correctly scoped
  to where the identity it needs is actually available.
- **Count-query errors on destructive-guard checks fail loud.** The checks
  preventing "disable money tracking with existing ledger entries" and
  "delete a container with confirmed ledger entries" explicitly check for
  a Postgres error on the count query itself and throw rather than
  silently treating a failed query as a zero count.
- **Invite acceptance is a single atomic conditional `UPDATE ... WHERE
  used_at IS NULL`**, so only one of two concurrent requests can ever
  successfully claim the same invite.
- **The GDPR data export worker resolves `workspace_members` rows once, up
  front, and reuses that resolution for both the ledger query and the task
  query** — since `ledger_entries.contributor_id` and
  `container_tasks.assigned_to` both store `workspace_members.id`, a
  single resolution keeps the two queries consistent.
- **Setting a contributor's target amount is one atomic
  `set_contributor_target_atomic` RPC** rather than several sequential,
  non-transactional writes.
- **Dispute raise/resolve, event-to-recurring container conversion, and
  contact list replacement all go through atomic Postgres RPCs**
  (`raise_dispute_atomic`, `resolve_dispute_atomic`,
  `convert_event_to_recurring_atomic`, `replace_user_contacts_atomic`),
  closing the class of partial-failure risk that multiple
  non-transactional writes describing one logical operation would
  otherwise carry.
- **Ledger corrections can only be attached to confirmed entries.**
  Pending or proof-uploaded entries are edited or deleted directly instead,
  keeping the correction path scoped to genuinely immutable financial
  history.
- **A missing referenced ledger entry on dispute lookup returns a clean
  404** via `.maybeSingle()` and an explicit `NotFoundError`, rather than a
  raw Postgrest error.
- **The notification middleware throws `NotFoundError`** if the caller has
  no active workspace membership, rather than silently proceeding with a
  null recipient ID.
- **`data-export-queue` is registered in the BullMQ queue registry**
  (`QUEUE_NAMES`) alongside every other queue the application uses.
- **Cycle-start notifications send each participant their own target
  amount**, resolved individually per recipient rather than reusing a
  single shared amount.
- **`payment_method` rejects unrecognized values instead of silently
  coercing them to `'other'`.** Known synonyms (`"Bank Transfer"`,
  `"Cash"`, etc.) are still normalized; anything outside the known set is
  a validation error.
- **`family_type` and `recurrence_cadence` database constraints match
  their validator enums exactly**, including a full `weekly` cadence
  implementation in the cycle-generation worker so the value is honored
  end to end, not just accepted.
- **Participants cannot have money tracking disabled while they hold
  confirmed ledger entries** — the same protection that exists at the
  container level is enforced at the participant level too.

## Architecture

- **`workspace.routes.js` is split into one small Router per resource**
  (member, invite, group, container, participant, ledger, dispute, task,
  milestone), each mounted at its original path prefix. This keeps the
  Express static-before-dynamic route-ordering constraint scoped to small,
  individually reviewable files rather than a single very large one.
- **Business logic lives in a dedicated service module per controller.**
  Controllers for auth, container, dashboard, dispute, group, invite,
  ledger, member, milestone, notification, participant, search, task, and
  workspace are thin HTTP adapters; all Supabase/RPC calls, validation-
  adjacent business rules, and orchestration live in
  `services/*.service.js`.
- **The same extraction applies to background workers.**
  `background.workers.js`, `notification.worker.js`, and
  `data_export.worker.js` wire a BullMQ `Worker` to a service function; all
  DB reads/writes, notification orchestration, cycle math, and CSV/email
  building live in dedicated service modules
  (`reminder.service.js`, `cycle_generation.service.js`,
  `cycle_lifecycle.service.js`, `task_overdue.service.js`,
  `invite_cleanup.service.js`, `engagement_check.service.js`,
  `notification_outbox.service.js`, `notification_delivery.service.js`,
  `data_export.service.js`).
- **Audit-log concerns are split into two distinctly-named services** to
  keep responsibilities clear: `audit.service.js` (the fire-and-forget
  `log()`/`fromReq()` writer used by every mutating endpoint) and
  `audit_log.service.js` (the paginated *read* view and CSV export used by
  the admin audit-log UI).
- **Notification concerns are split into two distinctly-named services**
  for the same reason: `notification.service.js` (the central sender every
  controller/worker dispatches through) stays separate from
  `notification_inbox.service.js` (a recipient reading/managing their own
  inbox — list, unread count, mark-as-read).
- **Member-engagement computation is unified into a single shared
  implementation**, `engagement.service.js#fetchEngagementData`, used by
  both the engagement-check worker and the member controller's engagement
  endpoint — a single batched implementation rather than two independent
  ones.
- **Task CSV export is unified into a single shared implementation**,
  `export.service.js#exportTasksCSV`, with an `assignedTo` filter used by
  both the admin export path and the member-scoped path.
- **Pagination and sorting utilities are used consistently by every list
  endpoint** — `utils/pagination.js#getPagination()` and
  `utils/response.js#paginate()` centralize page/per_page/offset math and
  the pagination envelope; `utils/sorting.js#getSort()` centralizes
  `?sort=` parsing (descending-prefix handling, field whitelisting).
- **Timeline pagination uses per-source cursors.** The `/timeline`
  endpoint merges two sources (completed containers and milestones) and
  tracks `before_container` and `before_milestone` independently, so an
  uneven split between the two sources on one page never causes an item to
  be skipped on the next page. A bare `before` param is still honored for
  backward compatibility on the first request.
- **`family_type` is declared once**, shared consistently across the
  create-workspace and update-workspace validation schemas.
- **`last_seen_at` debounce uses a Redis `SET ... NX EX` claim**, giving
  true single-writer-per-window behavior across the whole fleet rather
  than one write per instance, and fails open (skips the write, doesn't
  block auth) if Redis is unavailable.
- **Workspace membership lookups are cached in Redis for 30 seconds**
  (`requireMembership`, which runs on every route mounted under
  `/v1/workspaces/:workspaceId`), with explicit invalidation on any write
  that changes an authorization-relevant field (`role`, `is_active`,
  `is_proxy`, `proxy_managed_by`) or on workspace deletion — an explicit,
  bounded staleness tradeoff.
- **Contact-list replacement is one atomic RPC** rather than a
  delete-then-upsert sequence, closing the window where a failed upsert
  after a successful delete could lose a user's contact methods with no
  rollback.

## Added

- **Full audit coverage for container creation, groups, and direct member
  creation** — `CONTAINER_CREATED` and the full set of `GROUP_*` actions,
  plus `MEMBER_CREATED`, along with the corresponding `audit.log()` call
  sites, so the activity feed captures "who created this savings pool" and
  "who added someone to this group" alongside every other tracked action.
- **`cycle_closing_soon` and `overdue_summary_admin` notifications are
  fully wired end to end**: `cycle_closing_soon` notifies participants of
  open recurring-pool cycles ending within 3 days who still have an
  outstanding balance; `overdue_summary_admin` sends workspace admins a
  per-container daily summary of overdue contributors, reusing data
  already fetched by the overdue-reminder scan rather than an extra query.
- **GDPR data export** (`POST /v1/auth/data-export`) — queues an async
  job that emails the requesting user CSV exports of their ledger
  contributions and task assignments across every workspace they were
  an active member of.
- **Notification outbox scanner** — a scheduled job that finds delivery
  records stuck in `pending` or `failed` (external channels only) for
  more than 5 minutes and re-enqueues them, closing the gap where a
  `queue.add()` failure at send time would otherwise silently drop a
  notification with no retry path (`notification_outbox.service.js`,
  scheduled every 5 minutes via `queues/scheduler.js`).
