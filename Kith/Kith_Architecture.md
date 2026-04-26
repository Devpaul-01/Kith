# Kith — System Architecture Document

> **Document Type:** Implementation-Grade Architecture Specification
> **Version:** 2.0 (Full Engineering Review Pass)
> **Stack:** Node.js · Express · Supabase (PostgreSQL + Auth + Storage) · BullMQ · Redis · Firebase FCM · Resend
> **Scope:** Multi-user · Multi-workspace · Family & Group Finance Coordinator
> **Status:** Ready for full-stack code generation

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Core Product Concepts & Domain Model](#2-core-product-concepts--domain-model)
3. [User Journey & Application Flow](#3-user-journey--application-flow)
4. [Feature Breakdown](#4-feature-breakdown)
5. [System Behavior & Business Logic](#5-system-behavior--business-logic)
6. [Data Flow](#6-data-flow)
7. [Background Processing & Async Logic](#7-background-processing--async-logic)
8. [Real-Time & Event Handling](#8-real-time--event-handling)
9. [Multi-User / Team Architecture](#9-multi-user--team-architecture)
10. [Edge Cases & System Resilience](#10-edge-cases--system-resilience)
11. [Performance & Scalability Thinking](#11-performance--scalability-thinking)
12. [Flexibility & Extensibility](#12-flexibility--extensibility)
13. [UX & Product Thinking](#13-ux--product-thinking)
14. [Non-Happy Paths](#14-non-happy-paths)
15. [Missing or Weak Areas](#15-missing-or-weak-areas)

---

## 1. System Overview

### 1.1 Purpose

Kith is a collaborative family and group finance coordinator — a structured, transparent platform for groups of people who share financial obligations and events. The name "Kith" (from "kith and kin") signals the core relationship: not strangers transacting anonymously, but trusted networks — families, diaspora communities, contribution circles — who already know and depend on each other but currently manage shared money through informal WhatsApp threads, spreadsheets, and collective memory.

### 1.2 Core Problem Solved

When a family organizes a wedding fund, a monthly savings pool, or a birthday contribution drive, the typical workflow involves a designated "treasurer" chasing people over text message, maintaining a spreadsheet no one else can see, and trying to remember who paid what and when. Disputes arise. Trust erodes. People don't contribute because they feel no accountability.

Kith replaces this chaos with a structured, multi-user platform where:
- Everyone can see the status of a contribution campaign
- Payments are recorded with optional proof-of-payment (bank transfer screenshots, receipts)
- Tasks related to an event are tracked alongside money
- Admins have tools to manage, dispute, correct, and audit everything
- Members receive push and email notifications and reminders tied to real deadlines
- The entire history is permanently auditable

### 1.3 Key Design Principles

**Workspace isolation above all else.** Every workspace is a complete silo. A user belonging to three workspaces cannot see, infer, or cross-reference any data between them through any API surface. Membership verification happens on every request via `requireMembership` middleware, which returns 404 — never 403 — to prevent workspace enumeration.

**Admin-first data integrity.** Confirmed financial data is immutable. Only admins can confirm contributions. Members submit and upload proof; they cannot unilaterally confirm their own payments. Corrections to confirmed entries require a new ledger row — they cannot be edited.

**Proxy member support.** Real families include children, elderly relatives, and anyone without a smartphone. Kith explicitly models proxy members — workspace entries for real people who have no account — managed by an admin on their behalf. This is not a workaround; it is a first-class product requirement.

**Async-first for side effects.** Notifications, reminders, cycle generation, and data exports are all async. If a queue is temporarily down, the primary user action succeeds and the side effect retries. No user-facing action fails because a notification could not be sent.

**Audit everything.** Every financially or structurally significant write logs to `audit_log` with actor, target, workspace, IP, and user agent. This is the paper trail that lets an admin reconstruct the exact sequence of events.

**Never fail silently on money.** All writes involving financial state transitions (raising disputes, resolving disputes, converting containers) use atomic PostgreSQL RPCs that wrap both sides in a single transaction. There are no two-step sequential writes on financial data.

**Fail fast at startup.** The server validates that all required environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `FRONTEND_URL`) exist before starting. Optional integrations (Firebase, Resend) degrade gracefully to `skipped` status rather than crashing.

### 1.4 Technology Stack

```
Layer                  Technology
─────────────────────────────────────────────────────────────────────
API Server             Express 4.x + Node.js
Database               Supabase (PostgreSQL) — supabase-js admin client
Auth                   Supabase Auth (JWT Bearer tokens)
Session Persistence    HttpOnly cookie for refresh token (path: /v1/auth/refresh)
File Storage           Supabase Storage — private bucket, signed URLs only
Background Jobs        BullMQ 5.x + Redis
Push Notifications     Firebase Admin SDK (FCM) — optional, degrades gracefully
Email                  Resend — optional, degrades gracefully
Input Validation       Zod (per-controller schema parsing)
Rate Limiting          express-rate-limit (in-memory store — see Section 15)
Logging                Winston (structured JSON)
Error Monitoring       Sentry (@sentry/node) — optional, initialized before all else
Queue Admin UI         Bull Board (@bull-board/express) — IP-restricted + Basic Auth
Compression            compression middleware (gzip)
Security               helmet + cors with credential support + cookieParser
```

### 1.5 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client (Web / Mobile)                      │
│   REST via HTTPS · Polling for notifications                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Bearer JWT + HTTPS
┌──────────────────────────────▼──────────────────────────────────┐
│                        Express API Server                       │
│  Routes → Middleware Chain → Controllers → Supabase Admin       │
│  (Stateless — trust proxy = 1 — horizontally scalable)          │
└──────────┬──────────────────────────────────────┬───────────────┘
           │                                      │
┌──────────▼───────────┐              ┌───────────▼────────────┐
│  Supabase            │              │  BullMQ / Redis        │
│  PostgreSQL (data)   │              │  Job Queues            │
│  Auth (JWT + OAuth)  │              │  Rate Limit State      │
│  Storage (files)     │              └───────────┬────────────┘
└──────────────────────┘                          │
                                    ┌─────────────▼────────────────┐
                                    │      Background Workers      │
                                    │  notification-worker         │
                                    │  notification-outbox-worker  │
                                    │  reminder-worker             │
                                    │  cycle-generation-worker     │
                                    │  cycle-lifecycle-worker      │
                                    │  task-overdue-worker         │
                                    │  invite-cleanup-worker       │
                                    │  engagement-check-worker     │
                                    │  data-export-worker          │
                                    └─────────────┬────────────────┘
                                                  │
                                    ┌─────────────▼────────────────┐
                                    │      External Services       │
                                    │  Firebase FCM (push)         │
                                    │  Resend (email)              │
                                    └──────────────────────────────┘
```

### 1.6 Service Boundaries

| Boundary | Responsibility | Critical Notes |
|---|---|---|
| API Server | Request routing, auth enforcement, validation, response shaping | Stateless. Uses `supabaseAdmin` (service role) for all DB — bypasses RLS. Trust proxy = 1 for accurate IP behind load balancers. |
| Background Workers | Async jobs, scheduled scans, notification delivery, cycle management | Separate BullMQ worker processes sharing the same Redis instance |
| Supabase PostgreSQL | All persistent data + atomic RPCs | Service role key bypasses RLS — defense in depth: RLS still defined for any accidental anon-key access |
| Supabase Auth | JWT issuance, session management, Google OAuth | Wrapped entirely within `auth.controller.js` |
| Supabase Storage | File uploads (proofs, avatars, cover photos, outcome files, milestone photos) | Signed URLs only — client uploads directly to Storage, API server is never in the file data path |
| Redis | BullMQ queue backing, rate limit state | Ephemeral — not a source of truth. Server degrades to "queues disabled" (not crash) if Redis is down at startup |
| Firebase FCM | Push notification delivery | Optional. Returns `null` from `getFirebaseApp()` if unconfigured. Worker marks deliveries `skipped`, not `failed` |
| Resend | Transactional email delivery | Optional. Data export worker logs a warning and returns cleanly if Resend is unconfigured |

### 1.7 Startup & Shutdown Lifecycle

**Startup sequence (`server.js`):**
1. `validateEnvironment()` — checks four required env vars, calls `process.exit(1)` with a clear message on any missing. Runs before any module is `require()`d.
2. Sentry initialization — if `SENTRY_DSN` is set, `Sentry.init()` runs before Express app construction (so it captures uncaught exceptions from startup).
3. `checkDb()` + `checkRedis()` — pre-flight checks run in parallel. DB failure is fatal (`process.exit(1)`). Redis failure is a warning ("queues disabled") — the API still starts.
4. `app.listen()` — server binds to `0.0.0.0:PORT`.

**Graceful shutdown (`SIGTERM` / `SIGINT`):**
- `server.close()` stops accepting new connections.
- A 10-second hard timeout forces `process.exit(1)` if existing connections don't drain.
- `unhandledRejection` logs the reason; `uncaughtException` logs and exits (prevents zombie processes).

### 1.8 Request Lifecycle

**Standard authenticated workspace request:**
```
Client
  ↓ HTTPS + Bearer JWT
Express Router
  ↓ requestId middleware         → attaches UUID to req + logs
  ↓ requestLogger                → structured log line per request
  ↓ generalLimiter (200/min/IP)  → in-memory; skipped in test env
  ↓ cookieParser                 → parses HttpOnly refresh token cookie
  ↓ requireAuth                  → verifies Supabase JWT → req.user = { id, email, full_name }
                                   → fire-and-forget: updates users.last_seen_at
  ↓ loadDbUser                   → fetches explicit user columns → req.dbUser
                                   → rejects if deleted_at IS NOT NULL
  ↓ requireMembership            → validates UUID format → queries workspace_members
                                   → returns 404 (never 403) if not found
                                   → req.member = { id, role, displayName, isProxy, isActive, workspaceId }
                                   → req.workspace = { id, name, baseCurrency, visibility, bankDetails }
  ↓ [requireAdmin]               → 403 if role !== 'admin'
  ↓ [requireSelfOrAdmin(fn)]     → 403 if not admin AND req.member.id !== getMemberId(req)
  ↓ Controller
     ↓ Zod schema parse (req.body / req.query / req.params)
     ↓ Business logic
     ↓ Supabase admin queries
     ↓ response.success() / response.paginate()
  ↓ errorHandler (global)
     ↓ ZodError         → 400 VALIDATION_FAILED + field + details array
     ↓ AppError         → err.statusCode + err.code + optional field/details
     ↓ PG 23505         → 409 CONFLICT
     ↓ PG 23503         → 422 BUSINESS_RULE_VIOLATION
     ↓ else             → 500 INTERNAL_ERROR (message hidden in production)
```

**Standard response envelopes:**
```json
// Success
{ "data": { ... } }

// Success + pagination
{
  "data": { ... },
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 45, "total_pages": 3 }
  }
}

// Error
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "field": "email", "details": [...] } }
```

### 1.9 Bull Board (Queue Monitor)

Mounted at `/admin/queues` only when `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD` env vars are both set. Protected by two guards applied in sequence:

1. **IP whitelist check:** Reads `ADMIN_IP_WHITELIST` env var (comma-separated, defaults to `127.0.0.1,::1`). Requests from non-whitelisted IPs get 403.
2. **HTTP Basic Auth:** Credentials validated against env vars using string comparison. Wrong credentials return 401 with `WWW-Authenticate: Basic realm="Kith Admin"`.

If Bull Board npm packages are not installed, the `require()` throws and the error is caught — the server starts normally with a warning log.

---

## 2. Core Product Concepts & Domain Model

### 2.1 User

A **User** is a human with an account in the Kith system. Each user has:
- A row in Supabase `auth.users` (managed by Supabase Auth)
- A row in the `users` application table (managed by the app)

The `users` row is created or upserted via `POST /v1/auth/register` (called after signup or Google OAuth). Until `register` is called, the user has a valid Supabase session but no `users` row. `loadDbUser` enforces this — it uses `.is('deleted_at', null)` and `.maybeSingle()`, and throws `UnauthorizedError('User profile not found. Please complete registration.')` if the row is absent.

**User fields (selected in loadDbUser):** `id`, `email`, `full_name`, `avatar_url`, `timezone`, `preferred_language`, `push_enabled`, `email_digest_enabled`, `deleted_at`

**Additional user fields (fetched in data export):** `country_of_residence`, `timezone`, `preferred_language`, `created_at`

**User contact methods** are stored in a separate `user_contacts` table — phone numbers, WhatsApp handles, social links — managed independently of the core user profile. See Section 4.2.

Users can belong to multiple workspaces simultaneously. Their identity is global; their workspace participation is scoped via `workspace_members`.

### 2.2 Workspace

A **Workspace** is the top-level organizational unit — equivalent to a named group or family. All data in Kith is strictly scoped to a workspace. A user can create a workspace or be invited into one.

**Workspace fields:** `id`, `name`, `base_currency`, `family_type` (extended, nuclear, blended, community, association, event, pool), `description`, `visibility` (private/public), `avatar_url`, `bank_details` (JSONB — payment instructions displayed to members), `deleted_at`

`base_currency` is the workspace's settlement currency. All ledger entries record both `original_amount + original_currency` and a `base_amount` in the workspace base currency, enabling workspaces whose members pay in multiple currencies to still compute a single total.

Workspace creation uses the `create_workspace_with_admin` PostgreSQL RPC, which atomically creates the workspace row AND the creator's `workspace_members` row as admin in a single transaction.

The `requireMembership` middleware fetches only the columns it needs from `workspaces`: `id`, `name`, `base_currency`, `visibility`, `bank_details`. It intentionally does not fetch `plan` or any subscription-level field (removed in Issue 8 cleanup).

### 2.3 Workspace Member

A **Workspace Member** is the join entity between a User and a Workspace. This is the correct place for role, workspace-local profile, proxy flag, and status — not on User or Workspace.

**Key fields:**
- `user_id` — links to `users`; NULL if this is a proxy member
- `workspace_id` — links to `workspaces`
- `role` — `admin` or `member`
- `display_name` — name used within this workspace (intentionally distinct from `users.full_name`)
- `is_proxy` — TRUE if no real account exists for this person
- `proxy_managed_by` — member ID of the admin who manages this proxy
- `is_active` — FALSE means deactivated (history retained)
- `deleted_at` — soft delete marker
- `relationship_to_head` — freeform label (e.g., "first son", "aunt")
- `relationship_category` — `blood`, `marriage`, `in_law`, `friend`, `other`
- `joined_at` — timestamp of membership creation
- `last_active_at` — updated by engagement check worker
- `contribution_streak_months` — streak counter for gamification
- `admin_notes` — admin-only private notes on this member (never returned to non-admins)

The `requireMembership` middleware selects: `id`, `role`, `display_name`, `is_proxy`, `is_active`, `workspace_id`.

### 2.4 Proxy Member

A **Proxy Member** is a `workspace_member` with `is_proxy = TRUE` and `user_id = NULL`. They represent real family members (a child, elderly parent) who cannot use the app.

**Proxy members can:** receive contribution targets; have ledger entries recorded on their behalf by an admin (creating a `proxy_actions` audit record); appear in group summaries and container participant lists; be assigned tasks tracked by their managing admin.

**Proxy members cannot:** log in; receive push or email notifications (suppressed at the notification service layer before any delivery record is created); be invited via invite link.

When an admin records a ledger entry with `contributor_id` pointing to a proxy member, the system verifies the caller is an admin and inserts a `proxy_actions` record for audit.

### 2.5 Role

Exactly two roles exist: `admin` and `member`. Role is workspace-scoped — a user can be admin in one workspace and member in another.

**Admin capabilities:** Create and manage containers; add, remove, and update members; confirm ledger entries; raise and resolve disputes; add corrections; create invite links; manage workspace settings; view audit log; see all members' financial details; generate public container links; create milestones; bulk create tasks; use cycle overrides.

**Member capabilities:** View containers they participate in; submit their own ledger entries; upload proof; view their own ledger history; update their own `display_name` and a limited field set; complete tasks assigned to them; view their own contribution summary; view the workspace timeline; view individual milestones; read notifications.

Role enforcement happens at two layers:
1. **Route layer:** `requireAdmin` middleware (403 if not admin); `requireSelfOrAdmin(fn)` middleware (403 if neither admin nor the target member)
2. **Controller layer:** Field-level restrictions (admin-only fields like `role`, `is_proxy`, `admin_notes`) and data scoping (non-admins only see their own entries)

### 2.6 Container

A **Container** is the most important domain concept in Kith. It is a named, purpose-bound bucket that holds money tracking, task tracking, or both. There are two types:

**Event container** (`container_type = 'event'`): A one-time occurrence with a defined end. Examples: a wedding fund, a birthday celebration, a group trip. Has a target amount, an event date, participants, and when done is completed with outcome files and an outcome description. Completion auto-generates a Milestone.

**Recurring container** (`container_type = 'recurring'`): A repeating pool. Examples: a monthly family savings pool, a quarterly contribution circle. Has a `recurrence_cadence` (monthly, quarterly, yearly, custom), `recurrence_start`, optional `recurrence_end`, and auto-generated cycles.

**Shared container attributes:**
- `enable_money` / `enable_tasks` — independent feature flags
- `budget_target` + `budget_currency` — optional fundraising goal
- `public_token` — random token enabling an anonymous public view
- `public_show_names` — whether contributor names are shown on the public page
- `carry_forward_unpaid` — for recurring containers: whether unpaid balances roll into the next cycle
- `cover_photos` — JSONB array of uploaded file objects
- `outcome_details` / `outcome_files` — set on completion
- `status` — `active`, `completed`, `archived`
- `deleted_at` — soft delete marker

**Container lifecycle:**
```
active → completed (event, via POST .../complete)
active → archived  (via POST .../archive)
soft-deleted (deleted_at set) → can be restored via POST .../restore
```

A soft-deleted container with no confirmed ledger entries can be fully hard-deleted. A container with confirmed ledger entries cannot be destroyed — it must be archived.

Converting an event container to recurring is supported via the `convert_event_to_recurring_atomic` PostgreSQL RPC.

### 2.7 Container Participant

A **Participant** is a `workspace_member` enrolled in a specific container. The `container_participants` join table holds per-member, per-container configuration.

**Fields:** `container_id`, `workspace_member_id`, `money_enabled`, `tasks_enabled`, `role` (freeform label: "Bride", "Best Man"), `notes` (admin notes), `exclude_from_public` (privacy on public view), `added_by`

A member cannot submit a ledger entry unless they are a participant with `money_enabled = true`. This is enforced in the `createEntry` controller — the absence of a participant row or `money_enabled = false` produces a specific, actionable error.

Participants can be added individually or from a Group.

### 2.8 Contributor Target

A **Contributor Target** is the expected amount a specific participant should contribute. Targets are versioned: setting a new target marks the old one `is_current = false` with `superseded_at` and `superseded_by` IDs, and creates a new row with `is_current = true`.

For recurring containers, each cycle generates per-cycle targets distinct from the standing target. Standing targets have `cycle_id = NULL`; cycle-specific targets have a `cycle_id`.

**Fields:** `container_participant_id`, `workspace_member_id`, `container_id`, `cycle_id`, `target_amount`, `target_currency`, `due_date`, `is_current`, `set_by`, `superseded_at`, `superseded_by`

### 2.9 Ledger Entry

A **Ledger Entry** is the fundamental financial record — a single contribution, expense, correction, or carry-forward amount recorded in a container.

**Entry types:** `contribution`, `expense`, `correction`, `carry_forward`

**Status lifecycle:**
```
member submits      → pending
member uploads proof → proof_uploaded
admin confirms      → confirmed
dispute raised      → disputed (from any non-confirmed state)
```

Confirmed entries are financially immutable. They cannot be edited or deleted. They can only be corrected with a new `correction` entry referencing the original via `corrects_entry_id`.

**Key fields:** `workspace_id`, `container_id`, `cycle_id`, `entry_type`, `contributor_id` (workspace_member.id), `original_amount`, `original_currency`, `base_amount`, `payment_method`, `status`, `note`, `proofs` (JSONB array of file objects), `recorded_by`, `confirmed_at`, `confirmed_by`, `corrects_entry_id`, `idempotency_key`, `recorded_at`

**`idempotency_key`:** Stored per entry. If `X-Idempotency-Key` header is present on POST, and a row with that key exists in the same workspace, the existing entry is returned with `idempotent: true` instead of creating a duplicate.

**Carry-forward entries** are system-generated (no `recorded_by`, `confirmed_at`, `confirmed_by`). They are immediately `confirmed` so they count toward the next cycle's totals.

### 2.10 Dispute

A **Dispute** is raised against a ledger entry when anyone believes it is incorrect. Both raise and resolve are atomic.

**Fields:** `ledger_entry_id`, `raised_by` (workspace_member.id), `reason`, `notes` (JSONB array: `[{ author_id, note, added_at }]`), `status` (`open` / `resolved`), `resolution_note`, `resolved_by`, `resolved_at`

`raiseDispute` uses the `raise_dispute_atomic` RPC — atomically inserts the dispute AND sets `ledger_entries.status = 'disputed'` in one transaction.

`resolveDispute` uses the `resolve_dispute_atomic` RPC — atomically updates dispute status AND ledger entry status in one transaction.

Notes can be added to an open dispute by any member (not admin-only) — it is a conversation thread. The `addDisputeNote` endpoint has no `requireAdmin` guard.

### 2.11 Group

A **Group** is a named subset of workspace members, used for bulk participant enrollment. Groups are workspace-scoped and admin-only.

**Fields:** `workspace_id`, `name`, `description`, `created_by`

`group_members` join table links groups to members. Adding members uses `upsert` with `ignoreDuplicates: true` — already-present members are silently skipped.

Used in `addParticipantsFromGroup` to bulk-enroll all group members into a container in one operation.

### 2.12 Container Cycle

A **Cycle** is a time-bounded period within a recurring container. The cycle generation worker creates them up to 3 months ahead.

**Fields:** `container_id`, `cycle_number`, `cycle_start`, `cycle_end`, `status` (`upcoming`, `open`, `closed`, `skipped`), `closed_at`

**Status logic in cycle generation worker:**
- `skipped` — if a `pause_pool` override exists for this `cycle_start`
- `open` — if `nextStart <= today` (the cycle's start date is already in the past or today)
- `upcoming` — all future cycles

**Status transitions (lifecycle worker):**
- `upcoming` → `open` when `cycle_start ≤ today`
- `open` → `closed` when `cycle_end < today` (with optional carry-forward)
- Any → `skipped` via `pause_pool` override at generation time

### 2.13 Pool Cycle Override

Admins can override cycle behavior per-container and per-member. Overrides are stored in `pool_cycle_overrides` and applied during cycle generation.

**Override types:**
- `pause_pool` — entire cycle is `skipped`; no targets or notifications for this period
- `skip_member` — specific member is excluded from a cycle (no target, no carry-forward for them)
- `adjust_target` — specific member gets a different `new_target` / `new_currency` for a cycle

The cycle generation worker pre-fetches all overrides for a container in a single query before the generation loop, building three lookup structures:
- `pauseOverrides` → `Set<cycleStartStr>` — O(1) lookup
- `skipOverrides` → `Set<"cycleStart:memberId">` — O(1) lookup
- `adjustOverrides` → `Map<"cycleStart:memberId", { new_target, new_currency }>` — O(1) lookup

This eliminates O(participants × cycles) per-cycle DB queries inside the loop.

### 2.14 Task

A **Task** is a to-do item within a container. Tasks have a `title`, optional `description`, optional `assigned_to` (workspace_member.id), optional `due_date`, `status` (`pending`, `in_progress`, `completed`, `overdue`, `cancelled`), `sort_order`, `completion_note`, `proofs` (JSONB array), `deleted_at`.

Tasks go overdue automatically via the daily `task-overdue-worker` scan (marks `status = 'overdue'` for all `pending` tasks past their `due_date`).

**Task permission matrix:**
| Operation | Who |
|---|---|
| Create task | Admin only |
| Bulk create (up to 50) | Admin only |
| Update status / add note | Any member (for tasks assigned to them); admin can update any task |
| Reassign | Admin only |
| Override status (hard set to any value) | Admin only |
| Admin-confirm completed task | Admin only |
| Delete | Admin only |
| Upload proof | Any member (upload-url); any member (confirm-proof) |
| Delete proof by index | Admin only (per route guard) |
| Export tasks as CSV | Any member (own tasks); admins see all |

**Route ordering note:** The static sub-paths `/export` and `/bulk` are declared **before** `/:taskId` in `workspace.routes.js` to prevent Express from capturing the word "export" as a `taskId` parameter.

### 2.15 Milestone

A **Milestone** is a significant life event in the workspace timeline. Types: `birth`, `graduation`, `wedding`, `death`, `migration`, `achievement`, `custom`.

**Fields:** `workspace_id`, `title`, `description`, `milestone_date`, `milestone_type`, `photos` (JSONB array of uploaded file objects), `created_by`, `deleted_at`

When a container is completed, a milestone of type `custom` is auto-created. Milestone fetch (`GET /milestones/:milestoneId`) is accessible to all members — no `requireAdmin`. Photo upload and confirm operations are admin-only.

### 2.16 Notification

A **Notification** is an in-app or external (push/email) alert to a specific workspace member.

**Notification fields:** `type`, `workspace_id`, `recipient_id` (workspace_members.id), `title`, `body`, `reference_type`, `reference_id`, `dedup_key`, `is_read`

**Delivery model:** For each notification, one or more `notification_deliveries` rows are created — one per channel defined in the template. In-app delivery is marked `delivered` synchronously inside `notification.send()`. External channels (push, email) are enqueued to `notification-queue` for async processing.

**notification_deliveries fields:** `notification_id`, `channel` (`in_app`, `push`, `email`), `status` (`pending`, `delivered`, `failed`, `skipped`), `retry_count`, `last_attempt_at`, `delivered_at`, `error_message`

The `notification-outbox-worker` scans every 5 minutes for deliveries stuck in `pending` or `failed` for external channels for more than 5 minutes and re-enqueues them.

**Template registry** (notification types with their channels):
```
contribution_submitted   → in_app, push  (to admins)
contribution_confirmed   → in_app, push  (to contributor)
contribution_disputed    → in_app, push  (to contributor and/or admin)
dispute_resolved         → in_app, push  (to disputing member)
task_assigned            → in_app, push  (to assignee)
task_completed           → in_app, push  (to admins)
task_overdue             → in_app, push  (to assignee + admins)
invite_accepted          → in_app, push  (to admins)
payment_reminder         → in_app, push  (to member)
overdue_reminder         → in_app, push  (to member)
cycle_started            → in_app, push  (to each participant with their own target)
cycle_closing_soon       → in_app, push  (to participants)
container_completed      → in_app, push  (to participants)
admin_announcement       → in_app, push  (to all or role-filtered members)
overdue_summary_admin    → in_app, push  (to admins)
member_removed           → in_app        (to removed member)
```

### 2.17 Audit Log

`audit_log` is permanent and append-only. Every significant write operation creates an entry via `audit.fromReq(req)` which extracts: `workspace_id`, `actor_user_id`, `actor_member_id`, `action` (e.g., `ledger.confirmed`, `container.completed`), `target_type`, `target_id`, `metadata` (JSONB), `ip_address`, `user_agent`.

The `audit.log()` function is fire-and-forget — it `catch()`es all errors and never throws, never blocking the primary operation.

Admins can query the audit log with filters for `action`, `actor_member_id`, and date range. They can export up to 10,000 rows as a CSV stream.

**Route ordering note:** `/ledger/export` is declared at the workspace level (`GET /ledger/export`) and `/ledger/summary` is declared before `/:entryId` in the route file — both to prevent Express from interpreting the static path segments as ID parameters.

### 2.18 Invite Link

An **Invite Link** is a single-use, 7-day-expiring token granting access to a specific workspace. Only admins can create them.

**Fields:** `workspace_id`, `token`, `created_by`, `expires_at`, `used_at`, `used_by`

The preview endpoint (`GET /v1/public/invites/:token`) returns workspace name, inviter name, and a snapshot of active containers — no auth required. This is the invite landing page data.

`POST /v1/public/invites/:token/accept` requires auth. It checks `expires_at` and `used_at`, creates a `workspace_members` row, marks `used_at`, and notifies admins.

The legacy route path `/v1/invites/:token/preview` (without `/public`) is kept for backwards compatibility.

Expired, unused invite links are cleaned up by `invite-cleanup-worker`. Used invite links are retained for audit.

---

## 3. User Journey & Application Flow

### 3.1 Signup (Email/Password)

1. User submits email, password, full name, and optional timezone/country.
2. `POST /v1/auth/signup` (rate-limited: 5/min/IP) calls Supabase `auth.signUp()`.
3. Supabase creates a row in `auth.users` and sends a verification email.
4. **If email confirmation required:** API returns `{ message: "Check your email..." }`. No session yet.
5. **If auto-confirm on:** Returns `access_token` + `refresh_token` immediately.
6. User clicks the email verification link which includes a `token_hash`.
7. Frontend calls `POST /v1/auth/verify-email` with `{ token_hash, type: 'email' }` — Supabase verifies the OTP and returns a session.
8. Session established. Frontend stores `access_token` in memory; `refresh_token` is stored in an HttpOnly cookie at path `/v1/auth/refresh`.

### 3.2 Login & Session Management

1. `POST /v1/auth/login` (rate-limited) → Supabase validates credentials → returns `access_token` + sets `refresh_token` cookie. The response also includes the user's workspace memberships (from `GET /v1/auth/me` data) so the frontend can build the workspace switcher immediately.
2. `POST /v1/auth/refresh` → browser sends HttpOnly cookie automatically → Supabase issues a new `access_token`.
3. `POST /v1/auth/logout` → invalidates the current Supabase session → clears the cookie.
4. `POST /v1/auth/logout-all-devices` → calls Supabase `auth.admin.signOut(userId, 'global')` → revokes all sessions across all devices.
5. `requireAuth` fires on every authenticated request — it calls `supabaseAdmin.auth.getUser(token)` and fire-and-forgets an `update({ last_seen_at })` on `users`.

### 3.3 Google OAuth Flow

1. `GET /v1/auth/google/url` → calls Supabase `auth.signInWithOAuth({ provider: 'google' })` → returns the redirect URL.
2. Frontend navigates to the URL. Google handles authentication and redirects to `FRONTEND_URL/auth/callback?code=...`.
3. Frontend sends `POST /v1/auth/google/callback` with the `{ code }`.
4. Backend calls Supabase `auth.exchangeCodeForSession(code)` → receives session.
5. Backend upserts the `users` row with Google metadata (name from `user_metadata`, avatar URL).
6. Returns tokens. Session established. No email verification step needed.

### 3.4 Profile Completion

`POST /v1/auth/register` is the idempotent "complete my profile" step called after both email signup and Google OAuth. It handles:
- Upsert of the `users` row (creates if first time, updates if re-called)
- Setting `full_name`, `timezone`, `preferred_language`, `country_of_residence`, `auth_provider`
- For OAuth users: pulling `full_name` from `user_metadata` if not supplied in the request body

`GET /v1/auth/me` returns the user's global profile plus all active workspace memberships (`member_id`, `role`, `workspace.id`, `workspace.name`, `workspace.base_currency`) — this is the data the frontend needs to render the workspace switcher.

### 3.5 Profile & Contact Management

**Profile update:** `PATCH /v1/auth/profile` allows updating `full_name`, `timezone`, `preferred_language`, `country_of_residence`, `bio`, `avatar_url`. Requires auth + `loadDbUser`. Avatar upload follows the two-step pattern: `POST /v1/auth/avatar/upload-url` → client uploads to Supabase Storage → `PATCH /v1/auth/profile` with the `avatar_url`.

**User contacts:** Contact methods (phone, WhatsApp, social links) are managed via a dedicated `user_contacts` table — separate from the core user profile. Endpoints:
- `GET /v1/auth/contacts` — list all contact methods for the current user
- `POST /v1/auth/contacts` — upsert a contact method (create or update by type)
- `PATCH /v1/auth/contacts` — bulk replace all contact methods
- `DELETE /v1/auth/contacts/:contactId` — remove a specific contact method

Contacts are user-scoped, not workspace-scoped. They are included in the GDPR data export.

**Notification preferences:**
- `POST /v1/auth/push-token` → stores `push_token` and `push_token_platform` on the `users` row
- `PATCH /v1/auth/notification-preferences` → toggles `push_enabled` and `email_digest_enabled` on the `users` row

### 3.6 New User Onboarding (No Workspace)

After login, if the user has no workspace memberships (detected from the `GET /v1/auth/me` response), the frontend shows two choices:

**Create a workspace:**
1. `POST /v1/workspaces` (top-level endpoint, no `workspaceId`) calls the `create_workspace_with_admin` RPC.
2. The RPC atomically creates the `workspaces` row AND the `workspace_members` row for the creator as admin.
3. The new workspace is returned. Frontend navigates into it.

**Join via invite link:**
1. User navigates to an invite URL (e.g., `https://kith.app/invite/abc123`).
2. Frontend calls `GET /v1/public/invites/abc123` → receives workspace name, inviter, active containers.
3. User logs in or signs up (returning to the invite URL after auth).
4. Frontend calls `POST /v1/public/invites/abc123/accept` with the user's JWT.
5. A `workspace_members` row is created. The invite is marked `used_at`. Admins are notified.

### 3.7 Daily Usage — Admin

1. Opens app. JWT is silently refreshed via cookie if needed.
2. **Dashboard:** `GET /v1/workspaces/:workspaceId/dashboard` — runs 7 parallel Supabase queries:
   - Total member count
   - Active event containers (with confirmed total vs budget)
   - Active recurring pools (with current open cycle info)
   - Upcoming contribution deadlines (next 14 days) from `contributor_targets`
   - Recent audit log entries (activity feed)
   - Top 10 pending/proof_uploaded ledger entries needing confirmation (admin only)
   - Unread notification count
3. **Confirms a payment:** Reviews proof → `POST /.../ledger/:entryId/confirm` → member notified instantly via in-app + push.
4. **Broadcasts an announcement:** `POST /v1/workspaces/:workspaceId/announce` with `{ message, target_role? }` → sends `admin_announcement` notifications to all (or role-filtered) active members.
5. **Checks overdue summary:** `GET /v1/workspaces/:workspaceId/overdue-summary` → cross-container view of all members with past-due targets.
6. **Views audit log:** `GET /v1/workspaces/:workspaceId/audit-log?action=ledger.confirmed&page=1` → paginated, filterable.

### 3.8 Daily Usage — Member

1. Opens app. Sees notification badge from `GET /v1/notifications/count`.
2. **Loads notifications:** `GET /v1/notifications?workspace_id=...` → paginated inbox. Mark read via `PATCH /v1/notifications/:id/read` or `PATCH /v1/notifications/read-all`.
3. **Records a contribution:**
   a. `POST /v1/workspaces/:workspaceId/containers/:containerId/ledger` → creates `pending` entry.
   b. Requests upload URL: `POST /.../ledger/:entryId/upload-proof` with `{ filename, content_type, file_size }` → receives `{ upload_url, file_path, expires_in: 300 }`.
   c. Client uploads file directly to Supabase Storage via the signed URL.
   d. `POST /.../ledger/:entryId/confirm-proof` with `{ file_path, name, size, mime_type }` → entry status becomes `proof_uploaded`. Admins are notified.
4. **Checks personal summary:** `GET /v1/workspaces/:workspaceId/members/:memberId/contribution-summary` → all containers the member participates in, with their target, paid total, and outstanding balance.
5. **Completes a task:** `PATCH /.../tasks/:taskId` with `{ status: 'completed', completion_note: '...' }` → admins notified.

### 3.9 Admin Inviting a Member

1. `POST /v1/workspaces/:workspaceId/invites` → admin creates invite → receives `{ token, invite_url, expires_at }`.
2. Admin shares the URL via WhatsApp, SMS, or email outside of Kith.
3. Invitee opens the URL → frontend calls `GET /v1/public/invites/:token` → workspace preview shown.
4. Invitee signs up or logs in.
5. `POST /v1/public/invites/:token/accept` with JWT → membership created → admins notified.
6. Admin can revoke unused invites: `DELETE /v1/workspaces/:workspaceId/invites/:inviteId`.
7. Admin can list all invites: `GET /v1/workspaces/:workspaceId/invites`.

### 3.10 Recurring Pool Lifecycle

1. Admin creates a recurring container: `POST /v1/workspaces/:workspaceId/containers` with `container_type: 'recurring'`, `recurrence_cadence`, `recurrence_start`.
2. The controller enqueues a `cycle-generation-queue` job immediately.
3. The cycle generation worker generates cycles 3 months ahead. Past-start cycles are created as `open`; future cycles as `upcoming`.
4. On each `cycle_start` date: the daily lifecycle worker transitions `upcoming` → `open`. Each participant receives a `cycle_started` push notification with their personal target amount (not a generic amount — each participant gets their own).
5. Members contribute through the cycle as normal.
6. On each `cycle_end` date: the lifecycle worker transitions `open` → `closed`. If `carry_forward_unpaid = true`: calculates outstanding balance per participant, finds the next `open` or `upcoming` cycle, and inserts system-generated `carry_forward` ledger entries (immediately `confirmed`, `recorded_by = NULL`).
7. After closing, the lifecycle worker re-enqueues cycle generation to maintain the 3-month lookahead.

### 3.11 GDPR Data Export

1. `POST /v1/auth/data-export` → fetches the user's active workspace IDs → enqueues a `data-export-queue` job with `{ userId, userEmail, workspaceIds }`.
2. The API immediately returns `{ message: "Export queued. You'll receive an email within 24 hours." }`.
3. The `data-export-worker` (concurrency: 2) fetches:
   - User profile (name, email, country, timezone, created_at)
   - All ledger entries where `contributor_id = userId` across those workspaces
   - Member IDs for the user → all tasks assigned to those member IDs
4. Builds two CSV files: `kith-contributions-{date}.csv` and `kith-tasks-{date}.csv`.
5. Emails both as Base64 attachments via Resend. If Resend is unconfigured, logs a warning and returns cleanly (no crash).

---

## 4. Feature Breakdown

### 4.1 Authentication & Session Management

**Endpoints:**
```
POST /v1/auth/signup                   Rate-limited 5/min/IP
POST /v1/auth/login                    Rate-limited 5/min/IP
POST /v1/auth/refresh                  Rate-limited 5/min/IP
POST /v1/auth/forgot-password          Rate-limited — always 200 (prevents enumeration)
GET  /v1/auth/google/url               No rate limit (read-only)
POST /v1/auth/google/callback          Rate-limited 5/min/IP
POST /v1/auth/verify-email             Rate-limited 5/min/IP
POST /v1/auth/logout                   requireAuth
POST /v1/auth/logout-all-devices       requireAuth
POST /v1/auth/reset-password           requireAuth (uses short-lived recovery JWT)
POST /v1/auth/register                 requireAuth (idempotent profile completion)
GET  /v1/auth/me                       requireAuth + loadDbUser
PATCH /v1/auth/profile                 requireAuth + loadDbUser
POST /v1/auth/avatar/upload-url        requireAuth + loadDbUser + uploadLimiter (20/hr/user)
PATCH /v1/auth/contacts                requireAuth + loadDbUser
GET  /v1/auth/contacts                 requireAuth + loadDbUser
POST /v1/auth/contacts                 requireAuth + loadDbUser
DELETE /v1/auth/contacts/:contactId    requireAuth + loadDbUser
POST /v1/auth/push-token               requireAuth + loadDbUser
PATCH /v1/auth/notification-preferences requireAuth + loadDbUser
POST /v1/auth/data-export              requireAuth + loadDbUser
```

**Supabase error mapping** (`mapSupabaseAuthError`):
- "User already registered" → 409 ConflictError
- "Email not confirmed" → 403 BusinessRuleError("Please verify your email address before logging in...")
- "Invalid login credentials" → 401 UnauthorizedError
- Any other Supabase error → 401 UnauthorizedError with the original message

**Password reset flow:** `POST /forgot-password` calls `supabaseAdmin.auth.resetPasswordForEmail()` and always returns HTTP 200 regardless of whether the email exists. `POST /reset-password` requires the user to be authenticated with the short-lived recovery JWT that Supabase embeds in the reset link.

**`loadDbUser` design:** Selects an explicit column list rather than `SELECT *`. This is a deliberate optimization: the middleware runs on every authenticated request. Over-fetching on a hot-path middleware that executes for every request would significantly increase DB data transfer.

### 4.2 User Contact Methods

Contact methods represent how a member can be reached outside of Kith (phone, WhatsApp handle, Instagram, etc.). These are stored in `user_contacts`, not in `users`.

**Bulk replace (`PATCH /contacts`):** Replaces all contact methods for the user atomically — useful for form-based save where the frontend sends the complete new set.

**Upsert (`POST /contacts`):** Creates or updates a single contact by type — useful for incremental edits.

**Purpose:** Contact details are included in the member profile visible to workspace admins, allowing them to reach members through channels outside the app (e.g., call or WhatsApp someone who hasn't seen their notification).

### 4.3 Workspace Management

**Top-level workspace operations** are mounted directly on the Express app (not through the workspace router) to allow access before a `workspaceId` is available:
```
GET  /v1/workspaces    requireAuth + loadDbUser → list all active memberships
POST /v1/workspaces    requireAuth + loadDbUser → create workspace (via RPC)
```

**Workspace-scoped operations** (all require `requireMembership`):
```
GET    /v1/workspaces/:workspaceId/             → getWorkspace
PATCH  /v1/workspaces/:workspaceId/             requireAdmin → updateWorkspace
DELETE /v1/workspaces/:workspaceId/             requireAdmin → deleteWorkspace (soft)
GET    /v1/workspaces/:workspaceId/dashboard    → getDashboard
GET    /v1/workspaces/:workspaceId/settings     requireAdmin → getSettings
PATCH  /v1/workspaces/:workspaceId/settings     requireAdmin → updateSettings
GET    /v1/workspaces/:workspaceId/search       → searchWorkspace (members + containers)
POST   /v1/workspaces/:workspaceId/announce     requireAdmin → announceToWorkspace
GET    /v1/workspaces/:workspaceId/audit-log    requireAdmin → getAuditLog (paginated + filterable)
GET    /v1/workspaces/:workspaceId/audit-log/export requireAdmin → exportAuditLog (CSV, max 10k rows)
GET    /v1/workspaces/:workspaceId/overdue-summary requireAdmin → getOverdueSummary
POST   /v1/workspaces/:workspaceId/avatar-upload-url requireAdmin + uploadLimiter
```

**Dashboard parallelism:** 7 Supabase queries run via `Promise.all()`. The dashboard result is never cached — it always reflects the current state. Pending confirmations are only included in the response if the caller is an admin (data scoping).

**Search:** `GET /search?q=...` searches `workspace_members.display_name` AND `containers.name` in parallel. Results are combined and returned as `{ members: [...], containers: [...] }`. Useful for global workspace navigation.

**Workspace settings** are stored as key-value pairs in `workspace_settings`. The `updateSettingsSchema` Zod validator defines typed fields: `reminder_templates` (custom text), `notification_prefs`, `invite_message`. This is a known structural tension — the schema knows the shape but the table doesn't enforce it at the DB level (see Section 15).

### 4.4 Member Management

**Endpoints:**
```
GET    /members                              → listMembers (with optional role/proxy/search filters)
POST   /members                              requireAdmin → createMember
GET    /members/engagement                   requireAdmin → getMemberEngagement
GET    /members/:memberId                    → getMember (admin sees all fields; member sees limited)
PATCH  /members/:memberId                    requireSelfOrAdmin() → updateMember
DELETE /members/:memberId                    requireAdmin → deleteMember
GET    /members/:memberId/profile-history    requireAdmin → getProfileHistory
GET    /members/:memberId/contribution-summary → getContributionSummary (requireSelfOrAdmin enforced in controller)
```

**Member creation** supports both regular and proxy members. For proxy: `is_proxy: true` in the request body. `proxy_managed_by` must be an active admin member ID.

**Updating a member — field-level restrictions:**
- `requireSelfOrAdmin()` passes route-level auth (admin OR self).
- Inside the controller: admin-only fields (`role`, `is_proxy`, `admin_notes`, `is_active`, `proxy_managed_by`) are stripped from the update payload if the caller is not an admin. Members can only update: `display_name`, `relationship_to_head`, `relationship_category`, `date_of_birth`.
- Optimistic locking: if the request includes a `version` field (the member's `updated_at` timestamp), the update uses a conditional `WHERE updated_at = :version`. A mismatch returns a 409 "Member was updated by someone else."

**Profile history:** Every field-level change to a member's profile is logged individually to `member_profile_audit` with `changed_field`, `old_value`, `new_value`, `changed_by`, `changed_at`. `GET /members/:memberId/profile-history` returns this log paginated (admin only).

**Deleting a member:**
- If target has confirmed ledger entries: soft-delete only (`deleted_at` set, `is_active = false`). Hard delete is blocked.
- If no confirmed ledger entries AND `?force=true`: hard delete. No `force=true` → soft delete.
- **Last-admin guard:** If target is the workspace's only admin, deletion is rejected with a `BusinessRuleError`.

**Demoting the last admin:**
- `updateMember` with `role: 'member'` where the target is the only admin → rejected with a `BusinessRuleError`.

**Engagement analytics:** `getMemberEngagement` classifies members as `active` / `quiet` / `inactive` based on days since `last_active_at`:
- `active`: last seen ≤ 30 days ago
- `quiet`: last seen 31–90 days ago
- `inactive`: last seen > 90 days ago or never

`admin_notes` is excluded from all non-admin member responses.

### 4.5 Groups

**Endpoints:**
```
GET    /groups                      → listGroups (admin-only; returns name, member count)
POST   /groups                      requireAdmin → createGroup (with optional member_ids)
GET    /groups/:groupId             requireAdmin → getGroup (full with members)
PATCH  /groups/:groupId             requireAdmin → updateGroup
DELETE /groups/:groupId             requireAdmin → deleteGroup
POST   /groups/:groupId/members     requireAdmin → addGroupMembers (upsert, ignoreDuplicates)
DELETE /groups/:groupId/members/:memberId requireAdmin → removeGroupMember
```

### 4.6 Containers

**Endpoints:**
```
GET  /containers                                  → listContainers (with status/type filters)
POST /containers                                  requireAdmin → createContainer
GET  /containers/:containerId                     → getContainer
PATCH /containers/:containerId                    requireAdmin → updateContainer
DELETE /containers/:containerId                   requireAdmin → deleteContainer (soft)
POST /containers/:containerId/restore             requireAdmin → restoreContainer
POST /containers/:containerId/complete            requireAdmin → completeContainer
POST /containers/:containerId/convert-to-recurring requireAdmin → convertToRecurring (atomic RPC)
POST /containers/:containerId/archive             requireAdmin → archiveContainer
POST /containers/:containerId/generate-public-link requireAdmin → generatePublicLink
GET  /containers/:containerId/summary             → getSummary
GET  /containers/:containerId/cycles              requireAdmin → listCycles
POST /containers/:containerId/outcome-files/upload-url requireAdmin + uploadLimiter
POST /containers/:containerId/cover-photos/upload-url  requireAdmin + uploadLimiter
```

**Completion flow:** `POST .../complete` accepts `{ outcome_details, outcome_files }`. On completion: status set to `completed`; a milestone is auto-created (failure is caught and logged — does not roll back the completion); all participants are notified with `container_completed`; an audit log entry is written. Outcome files and cover photos follow the two-step upload pattern.

**Container summary — access-controlled response:** The summary returns per-participant payment status (`paid`, `partial`, `overdue`, `pending`, `no_target`), totals per participant, and progress toward the budget. Non-admins see only their own financial details plus status indicators for other participants (no amounts for others). Admins see full details for all.

**Public view:** `GET /v1/public/containers/:publicToken` — no auth required. Returns container name, description, progress totals. Contributor names are included only if `public_show_names = true`; otherwise identities are redacted.

**Convert to recurring:** Uses `convert_event_to_recurring_atomic` RPC. This is one of three atomic RPCs in the system. After the RPC succeeds, a cycle generation job is immediately enqueued.

**Cover photos:** JSONB array on the container. Upload follows two-step; `PATCH /containers/:containerId` adds the file object to the array.

**Disabling money on an existing container:** Rejected if any ledger entries exist — cannot retroactively remove financial tracking from a container with history.

### 4.7 Container Participants

**Endpoints:**
```
GET    /containers/:containerId/participants                              requireAdmin
POST   /containers/:containerId/participants                              requireAdmin (array input)
POST   /containers/:containerId/participants/from-group                  requireAdmin
PATCH  /containers/:containerId/participants/:participantId              requireAdmin
DELETE /containers/:containerId/participants/:participantId              requireAdmin
POST   /containers/:containerId/participants/:participantId/set-target   requireAdmin
GET    /containers/:containerId/participants/:participantId/target-history requireAdmin
GET    /containers/:containerId/participants/:participantId/cycle-targets requireAdmin
POST   /containers/:containerId/cycles/:cycleId/override                 requireAdmin
```

**Bulk add participants:** Accepts an array. Members not in the workspace are silently skipped (counted in the response as `skipped`). Already-present members are also silently skipped. If the container doesn't have `enable_money = true`, any `money_enabled: true` flags in the input are forced to `false`.

**Setting targets:** Creates a new `contributor_targets` row with `is_current = true`. The existing current target (if any) is updated to `is_current = false`, `superseded_at = now()`, `superseded_by = new_target_id`. This versioning preserves history — the full target change timeline is available in `getTargetHistory`.

**Cycle targets view:** `getCycleTargets` returns a chronological list of all cycles for the participant: their target per cycle, how much they paid (sum of confirmed ledger entries for that cycle), and the status (`paid`, `partial`, `no_payment`, `skipped`, `upcoming`).

**Cycle override:** `POST /cycles/:cycleId/override` accepts `{ override_type, member_id?, new_target?, new_currency? }`. The override is stored in `pool_cycle_overrides` and takes effect on the next cycle generation run.

### 4.8 Ledger (Contributions)

**Endpoints (all under `/containers/:containerId/ledger`):**
```
GET    /ledger                          → listEntries (filterable by status, contributor, date)
POST   /ledger                          → createEntry (member or admin; different behavior)
GET    /ledger/summary                  → getLedgerSummary (lightweight aggregate) ← BEFORE /:entryId
GET    /ledger/export                   requireAdmin → exportLedger (CSV, workspace-level, not container) ← at workspace level
GET    /ledger/:entryId                 → getEntry
PATCH  /ledger/:entryId                 → updateEntry (limited for members)
DELETE /ledger/:entryId                 → deleteEntry (members: own pending only; admins: any non-confirmed)
DELETE /ledger/:entryId/proof/:proofIndex → deleteProof
POST   /ledger/:entryId/upload-proof    uploadLimiter → getUploadProofUrl
POST   /ledger/:entryId/confirm-proof   → confirmProof
POST   /ledger/:entryId/confirm         requireAdmin → confirmEntry
POST   /ledger/:entryId/dispute         → raiseDispute (member can raise on own entry; admin on any)
POST   /ledger/:entryId/add-correction  requireAdmin → addCorrection
GET    /ledger/:entryId/proof-url       → getProofUrl (generates signed download URL, 15-min TTL)
```

**`/ledger/summary` and `/ledger/export` routing:** Static paths must be declared before `/:entryId` in the route file. This is explicitly documented in the route file with a comment. If the order is reversed, Express would capture "summary" and "export" as entry IDs.

**Member vs. Admin submission differences:**
- **Member:** `contributor_id` is forced to `req.member.id` (cannot record for others). Status starts at `pending`.
- **Admin:** `contributor_id` can be any workspace member. Entry is immediately `confirmed`. Creates a `proxy_actions` record if contributor is a proxy member.

**Idempotency protocol:**
1. If `X-Idempotency-Key` header present: check for existing row with that key in the workspace → return it if found (with `idempotent: true`). Skip time-window duplicate check.
2. If no idempotency key: check for existing entry with same contributor + amount + container within the last 10 minutes → return 409 with `duplicate_entry_id` if found. Client can override with `?force=true`.

**Proof management:**
- Upload URL: validates file type and size → generates signed Supabase Storage upload URL (TTL: 300 seconds) → returns `{ upload_url, file_path, expires_in }`. File path format: `workspaces/{workspaceId}/proofs/{entryId}/{timestamp}-{random}.{ext}`.
- Confirm proof: appends file object to `entry.proofs` JSONB array → if status was `pending`, transitions to `proof_uploaded` → notifies admins.
- Signed download URL: `getProofUrl` generates a 15-minute signed download URL from Supabase Storage on demand.
- Delete proof: removes entry at index `proofIndex` from the `proofs` JSONB array. Admin can delete from confirmed entries; members can only delete from their own non-confirmed entries.

**Corrections:** Confirmed entries cannot be edited. An admin creates a correction entry referencing the original via `corrects_entry_id`. Corrections are immediately `confirmed`, appear in the ledger, and reduce or increase the running total accordingly.

**Ledger export:** `GET /v1/workspaces/:workspaceId/ledger/export` — workspace-level, not container-level. Returns a CSV stream of all entries in the workspace, filterable by container and date range.

**Data scoping:** Non-admins only see their own entries. Admins see all. This is enforced in the `listEntries` and `getEntry` controllers by conditionally adding a `.eq('contributor_id', req.member.id)` filter.

### 4.9 Disputes

**Endpoints:**
```
GET  /disputes                           requireAdmin → listDisputes (paginated + filterable)
GET  /disputes/:disputeId                → getDispute (admin sees all; member sees own only)
POST /disputes/:disputeId/note           → addDisputeNote (any member — conversation thread)
POST /disputes/:disputeId/resolve        requireAdmin → resolveDispute (atomic RPC)
POST /containers/:containerId/ledger/:entryId/dispute → raiseDispute (atomic RPC)
```

**Raise dispute:** `raise_dispute_atomic` RPC: atomically inserts `disputes` row AND sets `ledger_entries.status = 'disputed'`. Without this RPC, a partial failure (dispute created, ledger not updated) would leave the system in an inconsistent state.

**Add dispute note:** The `notes` field is a JSONB array on the `disputes` row. Adding a note appends `{ author_id, note, added_at }` to the array. No `requireAdmin` — both the raising member and admins can add notes, making it a structured conversation thread.

**Resolve dispute:** `resolve_dispute_atomic` RPC: atomically updates dispute (`status = 'resolved'`, `resolution_note`, `resolved_by`, `resolved_at`) AND the linked ledger entry's status. After resolution, the disputing member receives a `dispute_resolved` notification.

### 4.10 Tasks

**Endpoints (all under `/containers/:containerId/tasks`):**
```
GET    /tasks                            → listTasks (members see own assigned; admins see all)
POST   /tasks                            requireAdmin → createTask
POST   /tasks/bulk                       requireAdmin → bulkCreateTasks (up to 50) ← BEFORE /:taskId
GET    /tasks/export                     → exportTasks (CSV) ← BEFORE /:taskId
GET    /tasks/:taskId                    → getTask
PATCH  /tasks/:taskId                    → updateTask (members: limited fields; admins: all)
DELETE /tasks/:taskId                    requireAdmin → deleteTask (soft)
PATCH  /tasks/:taskId/reassign           requireAdmin → reassignTask
PATCH  /tasks/:taskId/status             requireAdmin → overrideTaskStatus (hard override to any value)
POST   /tasks/:taskId/confirm            requireAdmin → adminConfirmTask
POST   /tasks/:taskId/upload-proof       uploadLimiter → getTaskProofUploadUrl
POST   /tasks/:taskId/confirm-proof      → confirmTaskProof
DELETE /tasks/:taskId/proof/:proofIndex  → deleteTaskProof
```

**Route ordering:** `/tasks/bulk` and `/tasks/export` are declared before `/:taskId` — without this, Express would treat "bulk" and "export" as task IDs.

**Bulk create:** Accepts an array of up to 50 task objects. Assigns sequential `sort_order` values based on input order. All created in a single batch insert.

**Member task permissions:** Members can update `status`, `completion_note`, and their own `proofs` for tasks assigned to them. They cannot reassign tasks, override status arbitrarily, or delete tasks.

**`overrideTaskStatus`:** Admin-only hard override that sets a task to any valid status regardless of current state. Distinct from the member-facing `updateTask` which validates allowed status transitions.

**Task export:** Returns CSV. Members get only their assigned tasks. Admins get all tasks in the container.

**Completion notification:** When a member marks a task as `completed`, all workspace admins receive a `task_completed` notification.

### 4.11 Timeline & Milestones

**Endpoints:**
```
GET  /timeline                                  → getTimeline (merged completed containers + milestones)
POST /milestones                                requireAdmin → createMilestone
GET  /milestones/:milestoneId                   → getMilestone (all members) ← BEFORE PATCH/DELETE
PATCH /milestones/:milestoneId                  requireAdmin → updateMilestone
DELETE /milestones/:milestoneId                 requireAdmin → deleteMilestone (soft)
POST /milestones/:milestoneId/photos/upload-url requireAdmin + uploadLimiter
POST /milestones/:milestoneId/photos/confirm    requireAdmin → confirmMilestonePhoto
```

**Timeline logic:** `getTimeline` fetches completed containers and milestones in parallel via `Promise.all()`. It merges them into a single chronological list sorted by date. Supports cursor-based pagination using a `before` date query parameter (items before that date), enabling infinite scroll.

**Auto-milestone on container completion:** When a container is completed, the controller attempts to create a milestone. This is wrapped in a `try/catch` — if it fails (e.g., DB error), the container completion still succeeds and the error is logged. The milestone is a non-critical side effect.

**getMilestone is accessible to all members** — no `requireAdmin` guard. This allows members to view milestones (life events) without admin privileges, which is appropriate for a family context.

### 4.12 Notifications

**User-facing endpoints** (user-scoped, not workspace-scoped — mounted at `/v1/notifications`):
```
GET    /v1/notifications/count         → getUnreadCount (lightweight badge poll)
GET    /v1/notifications               → listNotifications (paginated; filterable by is_read, workspace_id)
PATCH  /v1/notifications/read-all      → markAllAsRead (optionally scoped to workspace_id)
PATCH  /v1/notifications/:notificationId/read → markAsRead
```

**`resolveMember` middleware** (notification-routes specific): Notifications reference a `recipient_id` which is a `workspace_members.id`, not a `users.id`. This middleware maps the JWT user to their most recently joined active workspace member. If a `workspace_id` query param is provided, it scopes to that workspace. If no active membership is found, it throws `NotFoundError` (not a silent passthrough with `{ id: null }` — that was a prior bug that caused notifications to be queried with `recipient_id = null`).

**`GET /notifications/count`** is declared before `/:notificationId/read` in the route file to prevent "count" from being captured as a notification ID.

**`notification.send()` internals:**
1. Resolves the template from the registry → gets `title`, `body`, `channels`.
2. For each `recipientId`:
   - Fetches workspace_member + linked user record from Supabase.
   - If proxy member: skips all external channels silently (no delivery record created for push/email).
   - Upserts the `notifications` row with the `dedup_key` if provided. If the key already exists (same notification already sent): skips.
   - For `in_app` channel: inserts `notification_deliveries` row and immediately marks `status = 'delivered'`.
   - For `push` / `email` channels: inserts `notification_deliveries` row with `status = 'pending'`. Calls `notificationQueue.add(...)` with full job payload including recipient user data. If `queue.add()` fails: updates delivery to `status = 'failed'` (outbox picks it up).

**Deduplication key patterns:**
- Payment reminders: `payment_reminder:{targetId}:{scanDate}` → same reminder never sent twice on the same day
- Overdue reminders: `overdue_reminder:{targetId}:{scanDate}`
- Task overdue: `task-overdue:{taskId}:{scanDate}`

**Rate limiter on notification-worker:** BullMQ `limiter: { max: 50, duration: 1000 }` — maximum 50 FCM/email deliveries per second, preventing rate-limit violations from external services.

---

## 5. System Behavior & Business Logic

### 5.1 Currency & Base Amount Model

Every ledger entry stores two amount pairs:
- `original_amount` + `original_currency`: what the contributor actually sent (e.g., `50000 NGN`)
- `base_amount`: the equivalent in the workspace's `base_currency` (e.g., `30 GBP`)

**The API does not perform currency conversion.** The caller supplies both values. This is a deliberate design decision that avoids live rate API dependency, rate drift issues, and conversion timing disputes. The tradeoff: the recording admin must know the exchange rate. For a trusted-network finance app, this is acceptable.

`base_amount` is what all summaries, progress calculations, and export totals use. `original_amount + original_currency` are stored for the member's own reference and for the proof they upload.

### 5.2 Three-Layer Permission Model

```
Layer 1 — Route middleware
  requireAuth           → valid JWT + users row exists
  requireMembership     → active workspace member → req.member + req.workspace
  requireAdmin          → role === 'admin'
  requireSelfOrAdmin()  → admin OR req.member.id === getMemberId(req)

Layer 2 — Controller field-level checks
  Even if requireSelfOrAdmin passes, the controller checks:
    - Admin-only writable fields: role, is_proxy, admin_notes, is_active, proxy_managed_by
    - Admin-only readable fields: admin_notes (stripped from non-admin responses)

Layer 3 — Query-level data scoping
  Non-admins: .eq('contributor_id', req.member.id) on ledger queries
  Non-admins: .eq('assigned_to', req.member.id) on task queries
  Non-admins: dashboard pending confirmations omitted
```

`requireSelfOrAdmin()` takes a function argument that resolves the target member's ID from `req`. Default is `(req) => req.params.memberId`. This allows the same middleware to be reused for routes where the owner's ID comes from different locations.

**404 vs 403 for workspace access:** `requireMembership` deliberately returns 404 (not 403) when a workspace exists but the requesting user is not a member. This prevents workspace enumeration — an attacker cannot distinguish "workspace does not exist" from "you have no access."

### 5.3 Atomic Financial Operations (PostgreSQL RPCs)

Three operations in the system use PostgreSQL RPCs to ensure both sides of a state transition are atomic:

| RPC | What it atomizes |
|---|---|
| `create_workspace_with_admin` | Create workspace row + create admin member row |
| `raise_dispute_atomic` | Insert dispute row + set `ledger_entries.status = 'disputed'` |
| `resolve_dispute_atomic` | Update dispute row + update `ledger_entries.status` |
| `convert_event_to_recurring_atomic` | Create recurring container + migrate participants |

Without these RPCs, a partial failure (first write succeeds, second crashes) would produce an inconsistent state requiring manual DB intervention. The RPCs prevent this by running both operations in a single PostgreSQL transaction.

### 5.4 Proof Upload Architecture (Two-Step Pattern)

The two-step upload pattern is used for all file uploads in Kith: proofs, avatars, cover photos, outcome files, and milestone photos.

```
Step 1 — Client requests a signed upload URL:
  POST /upload-url
  Body: { filename, content_type, file_size }
  
  storage.service.js:
    1. validateUpload(category, contentType, fileSize) — MAX_SIZES + ALLOWED_TYPES per category
    2. Build safe file path: workspaces/{workspaceId}/{category}/{entityId}/{timestamp}-{random}.{ext}
    3. supabase.storage.from(BUCKET).createSignedUploadUrl(filePath)
    4. Return { upload_url, file_path, expires_in: 300 }

Step 2 — Client uploads directly to Supabase Storage (API server NOT in the data path)
  [Client → Supabase Storage directly via the signed URL]

Step 3 — Client confirms the upload:
  POST /confirm-proof (or /confirm-photo, etc.)
  Body: { file_path, name, size, mime_type }
  
  Controller:
    1. Build file object: { url: file_path, name, size, mime_type, uploaded_by, uploaded_at }
    2. Append to entity.proofs array (or cover_photos, or photos)
    3. UPDATE entity with new array
    4. If relevant: update status (e.g., ledger entry pending → proof_uploaded)
    5. Notify stakeholders
```

**File type categories and their allowed types/size limits** are defined in `storage.service.js` as `MAX_SIZES` and `ALLOWED_TYPES` maps keyed by category (`proof`, `avatar`, `cover_photo`, `outcome_file`, `milestone_photo`, `workspace_avatar`). The upload rate limiter (`uploadLimiter`: 20/hour/user) is applied at the route level for all upload-URL endpoints.

### 5.5 Duplicate Submission Detection

Two independent duplicate-detection mechanisms:

**Idempotency-key based (preferred):**
- Client sends `X-Idempotency-Key: <uuid>` header
- Controller checks for existing ledger entry with that key in the workspace
- If found: returns existing entry with `idempotent: true` — no new entry created
- If not found: creates the entry, stores the key

**Time-window based (fallback):**
- No idempotency key provided
- Controller checks: same `contributor_id` + `container_id` + `original_amount` within the last 10 minutes
- If found: 409 with `duplicate_entry_id` in the response
- Client must acknowledge with `?force=true` to override

### 5.6 Carry-Forward Logic

When a recurring container's cycle closes with `carry_forward_unpaid = true`, the lifecycle worker calculates outstanding balances and carries them forward.

**Algorithm:**
1. For each participant with `money_enabled = true` in the closing cycle:
2. Find their `contributor_targets` row where `cycle_id = closingCycle.id AND is_current = true`
3. Sum all confirmed `ledger_entries.base_amount` for that participant in that cycle
4. `outstanding = target_amount - sum_paid`
5. If `outstanding > 0`: find the next cycle (status in `open` or `upcoming`, ordered by `cycle_number ASC`)
6. If next cycle exists: insert a `carry_forward` ledger entry:
   - `entry_type: 'carry_forward'`, `status: 'confirmed'`
   - `recorded_by: null`, `confirmed_by: null` (system-generated)
   - `note: "Carried forward from cycle (closed {cycle_end})"`
   - `cycle_id: nextCycle.id`
7. If no next cycle exists (past `recurrence_end`): outstanding balance is currently not captured anywhere (see Section 15)

### 5.7 Engagement Classification

The engagement check worker updates `workspace_members.last_active_at` to the latest timestamp across three signals: the member's existing `last_active_at`, their most recent `confirmed_at` ledger entry, and their most recent `completed_at` task.

This runs in 3 total DB queries regardless of member count (previously: 2 queries per member = O(2N)):
1. `SELECT * FROM workspace_members WHERE is_proxy = false AND is_active = true`
2. `SELECT contributor_id, confirmed_at FROM ledger_entries WHERE contributor_id IN (...) AND status = 'confirmed'`
3. `SELECT assigned_to, completed_at FROM container_tasks WHERE assigned_to IN (...) AND status = 'completed'`

Results are aggregated into Maps in memory. Updates are issued as `Promise.all()` with conditional writes (`.or('last_active_at.is.null,last_active_at.lt.${latest}')`) to avoid unnecessary writes.

### 5.8 Soft Delete vs Hard Delete Policy

| Entity | Soft Delete | Hard Delete | Restore |
|---|---|---|---|
| Workspace | `deleted_at` set | Never supported | Not supported (no endpoint) |
| Container | `deleted_at` set | Only if no confirmed ledger entries + already soft-deleted | `POST .../restore` |
| Workspace Member | `deleted_at` + `is_active = false` | Only with `?force=true` AND no confirmed ledger entries | Not supported |
| Task | `deleted_at` set | Never | Not supported |
| Milestone | `deleted_at` set | Never | Not supported |
| Invite Link | N/A | On revoke (admin) or cleanup (expired unused) | N/A |
| Used Invite Link | Not deleted | Not deleted (kept for audit) | N/A |

---

## 6. Data Flow

### 6.1 Synchronous Flow: Member Submits a Contribution

```
POST /v1/workspaces/:wid/containers/:cid/ledger
Body: { entry_type, original_amount, original_currency, base_amount, payment_method, note, cycle_id? }
X-Idempotency-Key: <optional>

Middleware chain:
  requireAuth → req.user = { id, email, full_name }
  loadDbUser  → req.dbUser = { id, email, full_name, push_enabled, ... }
  requireMembership → req.member = { id, role: 'member', ... }

createEntry controller:
  1. Parse body with createLedgerEntrySchema (Zod)
  2. If idempotency key: check for existing entry → return if found
  3. contributor_id = req.member.id (forced for members; passed in for admins)
  4. Verify contributor is NOT a proxy member (proxy requires admin caller)
  5. Verify contributor_id is a participant in the container with money_enabled = true
  6. If cycle_id provided: verify it belongs to this container
  7. Time-window duplicate check (if no idempotency key)
  8. INSERT ledger_entry → status = 'pending'
  9. INSERT proxy_actions record (if contributor is proxy member)
  10. Fetch admin workspace_member IDs
  11. notification.send({ type: 'contribution_submitted', recipientIds: adminIds })
      → in_app deliveries: synchronous (admin sees badge immediately)
      → push deliveries: enqueued to notification-queue
  12. audit.log({ action: 'ledger.submitted', ... })  ← fire-and-forget
  
Response: HTTP 201
{ "data": { "entry": { id, status: 'pending', ... } } }
```

### 6.2 Synchronous Flow: Admin Confirms a Contribution

```
POST /v1/workspaces/:wid/containers/:cid/ledger/:eid/confirm

Middleware:
  requireAuth → requireMembership → requireAdmin

confirmEntry controller:
  1. Fetch ledger entry (must be in same workspace)
  2. Validate current status is 'pending' or 'proof_uploaded' (not already confirmed)
  3. UPDATE ledger_entries SET status='confirmed', confirmed_at=now(), confirmed_by=req.member.id
  4. notification.send({ type: 'contribution_confirmed', recipientIds: [entry.contributor_id] })
  5. audit.log({ action: 'ledger.confirmed', targetId: entryId })

Response: HTTP 200
{ "data": { "entry": { id, status: 'confirmed', confirmed_at, confirmed_by, ... } } }
```

### 6.3 Synchronous Flow: Member Uploads Proof (Three-Step)

```
Step 1 — POST /.../ledger/:entryId/upload-proof
Body: { filename: 'receipt.png', content_type: 'image/png', file_size: 450000 }
uploadLimiter: 20/hr/user

  storage.service.js:
    validateUpload('proof', 'image/png', 450000) → OK
    generateUploadUrl('proof', workspaceId, entryId, 'receipt.png')
    supabase.storage.createSignedUploadUrl(filePath, { expiresIn: 300 })
  
  Response: { upload_url: "https://...", file_path: "workspaces/.../receipt.png", expires_in: 300 }

Step 2 — Client uploads directly to Supabase Storage (PUT to signed URL)
  API server is NOT involved in this step.

Step 3 — POST /.../ledger/:entryId/confirm-proof
Body: { file_path: "workspaces/.../receipt.png", name: "receipt.png", size: 450000, mime_type: "image/png" }

  confirmProof controller:
    1. Fetch entry (must belong to this container and workspace)
    2. Verify caller can confirm (admin OR contributor === req.member.id)
    3. Build file object: { url: file_path, name, size, mime_type, uploaded_by: req.member.id, uploaded_at: now() }
    4. Append to entry.proofs array
    5. UPDATE ledger_entries SET proofs=[...], status='proof_uploaded' (if was 'pending')
    6. notification.send({ type: 'contribution_submitted', recipientIds: adminIds })
       → (re-notifies admins that proof has been added)
    7. audit.log({ action: 'ledger.proof_uploaded' })
  
  Response: HTTP 200 { "data": { "entry": { ..., status: 'proof_uploaded', proofs: [...] } } }
```

### 6.4 Asynchronous Flow: Full Notification Pipeline

```
Trigger: any controller calls notification.send({ type, workspaceId, recipientIds, variables, dedupKey })

notification.service.js send():
  1. Resolve template → { title, body, channels: ['in_app', 'push'] }
  2. For each recipientId in recipientIds:
     a. Fetch workspace_member record + linked users record (one query)
     b. If member.is_proxy = true:
          → Skip all external channels (push, email) entirely
          → Only process in_app if in channels list
     c. Check dedup_key: if dedup_key and existing notification with that key exists → SKIP entirely
     d. Upsert notification row → get notification_id
     e. For 'in_app' channel:
          INSERT notification_deliveries (status='pending')
          UPDATE notification_deliveries SET status='delivered'
          [synchronous — no queue]
     f. For 'push' channel:
          INSERT notification_deliveries (status='pending') → get delivery_id
          notificationQueue.add('deliver-push', {
            notification_id, delivery_id, channel: 'push',
            recipient_user_id, push_token, push_token_platform, push_enabled,
            title, body, reference_type, reference_id, workspace_id
          }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
          [If queue.add() fails]: UPDATE notification_deliveries SET status='failed'
                                  [outbox worker picks this up]

notification-worker (BullMQ, concurrency: 10, rate: 50/sec):
  1. Idempotency check: if delivery already 'delivered' → return early
  2. Increment retry_count + update last_attempt_at on delivery row
  3. If channel === 'push':
     a. getMessaging() → if null (Firebase not configured) → mark 'skipped', return
     b. If push_token is null or push_enabled is false → mark 'skipped', return
     c. Token rotation guard: re-fetch users.push_token → if != job.data.push_token → mark 'skipped', return
     d. messaging.send({ token, notification: { title, body }, data: { reference_type, reference_id, workspace_id, notification_id }, webpush if platform='web' })
     e. UPDATE delivery: status='delivered', delivered_at=now()
  4. If FCM throws:
     UPDATE delivery: status='failed', error_message = err.message.slice(0, 500)
     re-throw → BullMQ retries (up to 3 times, exponential backoff starting 5s)

notification-outbox-worker (every 5 minutes, concurrency: 1):
  1. Fetch up to 50 notification_deliveries WHERE:
     status IN ('pending', 'failed') AND channel != 'in_app' AND created_at < (now - 5min)
     [joins: notifications → workspace_members → users for all needed job data]
  2. For each stale delivery:
     - If notification.workspace_members.is_proxy → skip
     - notificationQueue.add('deliver-push', { ...all job data... })
     - UPDATE delivery: status='pending'
```

### 6.5 Asynchronous Flow: Daily Cycle Lifecycle Scan

```
Scheduled daily job → cycle-lifecycle-queue

cycle-lifecycle-worker:

Phase 1 — Open upcoming cycles:
  UPDATE container_cycles SET status='open'
    WHERE status='upcoming' AND cycle_start <= today
    RETURNING id, container_id
  
  For each newly opened cycle:
    Fetch container: workspace_id, name
    Fetch participants: workspace_member_id + their contributor_targets
    For each participant:
      Find their target for this specific cycle (cycle_id = cycle.id)
      notification.send({
        type: 'cycle_started',
        recipientIds: [participant.workspace_member_id],
        variables: { container: container.name, amount: target?.target_amount + ' ' + target?.target_currency || 'TBD' }
      })
      [Each participant gets their OWN target amount — not a shared first-participant amount]

Phase 2 — Close open cycles:
  Fetch container_cycles WHERE status='open' AND cycle_end < today
    [joined with containers for carry_forward_unpaid flag]
  
  For each closing cycle:
    If container.carry_forward_unpaid = true:
      Fetch participants (money_enabled = true) + their cycle targets + confirmed ledger
      Find nextCycle (status in open/upcoming, cycle_number ASC, ≠ current)
      For each participant:
        cycleTarget = targets.find(t => t.cycle_id === cycle.id && t.is_current)
        paid = sum(ledger entries for this participant in this cycle, status='confirmed')
        outstanding = cycleTarget.target_amount - paid
        If outstanding > 0 AND nextCycle exists:
          INSERT ledger_entry (entry_type='carry_forward', status='confirmed',
                               recorded_by=null, confirmed_by=null,
                               cycle_id=nextCycle.id, ...)
    
    UPDATE container_cycles SET status='closed', closed_at=now() WHERE id=cycle.id
    getQueue('cycle-generation-queue').add('generate-cycles', { container_id, generate_months_ahead: 3 })
```

---

## 7. Background Processing & Async Logic

### 7.1 Queue Registry

All queues are defined in `src/queues/index.js` in the `QUEUE_NAMES` array. `getQueue(name)` throws if the name is not in the array — preventing typo-based queue proliferation. Queues are lazily initialized and cached as singletons. `getAllQueues()` ensures all queues are initialized before returning them (used by Bull Board).

```
Queue Name                  Purpose                            Concurrency
────────────────────────────────────────────────────────────────────────────
notification-queue          Push + email delivery              10 (rate: 50/sec)
reminder-queue              Daily contribution reminders       1
cycle-generation-queue      Generate cycles 3 months ahead    5
cycle-lifecycle-queue       Open/close cycles + carry-forward  1
task-overdue-queue          Mark overdue tasks                 1
invite-cleanup-queue        Delete expired unused invites      1
engagement-check-queue      Update member last_active_at       1
notification-outbox-queue   Re-enqueue stale deliveries        1
data-export-queue           GDPR user data export              2
```

### 7.2 Reminder Worker

**Trigger:** Scheduled daily.
**Concurrency:** 1 — serial scan prevents duplicate reminders.

**Logic:**
1. `scanDate` = today's ISO date string (used for dedup keys)
2. `soonStr` = today + 7 days
3. Fetch `contributor_targets` with `is_current=true`, `cycle_id IS NULL` (standing targets only), `due_date BETWEEN scanDate AND soonStr`, joined to `containers` (must be `status='active'`).
4. For each: `notification.send({ type: 'payment_reminder', dedupKey: 'payment_reminder:{targetId}:{scanDate}' })` — dedup prevents sending the same reminder twice on the same day.
5. Fetch overdue targets: `is_current=true`, `cycle_id IS NULL`, `due_date < scanDate`, active containers.
6. For each: `notification.send({ type: 'overdue_reminder', dedupKey: 'overdue_reminder:{targetId}:{scanDate}' })`.

**Why cycle targets are excluded:** `cycle_id IS NULL` filter means cycle-level reminders are NOT sent by the reminder worker. The expectation is that cycle-started notifications handle contribution prompts for recurring pool participants. Cycle-specific overdue reminders are a gap (see Section 15).

### 7.3 Cycle Generation Worker

**Trigger:** Enqueued by `createContainer` (immediately on recurring container creation) and by `cycle-lifecycle-worker` (after each cycle closes).
**Payload:** `{ container_id, generate_months_ahead: 3 }`
**Concurrency:** 5 — multiple containers can generate cycles simultaneously.

**Algorithm (detailed):**
1. Fetch container. Must be `container_type='recurring'`, `status='active'`, `deleted_at IS NULL`.
2. Find last generated cycle (highest `cycle_number`). If none: `nextStart = recurrence_start`.
3. `cutoffDate = MIN(now + generate_months_ahead months, recurrence_end)`.
4. **Pre-fetch all overrides** in one query → build `pauseOverrides` (Set), `skipOverrides` (Set), `adjustOverrides` (Map).
5. **Pre-fetch all participants** (money_enabled = true) with their standing targets in one query.
6. While `nextStart <= cutoffDate`:
   - Calculate `cycleEnd` per cadence:
     - `monthly`: +1 month - 1 day
     - `quarterly`: +3 months - 1 day
     - `yearly`: +1 year - 1 day
     - `custom`: + `recurrence_days` (default 30) - 1 day
   - Determine status: `skipped` if pause override; `open` if `nextStart <= today`; else `upcoming`.
   - Upsert cycle with `{ onConflict: 'container_id,cycle_start', ignoreDuplicates: true }` — idempotent re-runs.
   - For each participant (skip overrides applied):
     - Resolve target: `adjustOverride?.new_target || baseTarget?.target_amount`
     - If target exists: upsert `contributor_targets` row with `{ ignoreDuplicates: true }`.
   - Advance: `nextStart = cycleEnd + 1 day`; `nextCycleNumber++`.

**Idempotency:** `upsert` with `ignoreDuplicates: true` on the `(container_id, cycle_start)` unique constraint means re-running the worker never creates duplicate cycles. Safe to retry.

### 7.4 Cycle Lifecycle Worker

**Trigger:** Scheduled daily.
**Concurrency:** 1 — serial prevents conflicting cycle state transitions.

**Open phase:** Bulk UPDATE using Supabase's `.update().eq().lte().select()` — a single query that updates all `upcoming` cycles whose start date has arrived and returns their IDs. Then for each newly opened cycle: sends `cycle_started` notifications with per-participant target amounts.

**Close phase:** Fetches open cycles with passed end dates (joined to containers for `carry_forward_unpaid`). For each: optionally creates carry-forward entries, then updates status to `closed` and re-enqueues cycle generation.

**Critical fix documented in source:** The `cycle_started` notification was previously sending participant #1's target amount to every participant. The fix sends each participant their own target by finding `p.contributor_targets.find(t => t.cycle_id === cycle.id)` per participant.

### 7.5 Task Overdue Worker

**Trigger:** Scheduled daily.
**Concurrency:** 1.

**Logic:** Bulk UPDATE `container_tasks` where `status='pending'` and `due_date < today` → `status='overdue'`. Returns updated task IDs. For each: fetches the container's workspace, builds a recipients list (assignee + all active admins, deduplicated), sends `task_overdue` notification with dedup key `task-overdue:{taskId}:{scanDate}`.

### 7.6 Invite Cleanup Worker

**Trigger:** Scheduled periodically.
**Concurrency:** 1.

**Logic:** `DELETE FROM invite_links WHERE expires_at < now() AND used_at IS NULL`. Only unused expired links are deleted. Used links are retained for audit trail.

### 7.7 Engagement Check Worker

**Trigger:** Scheduled periodically.
**Concurrency:** 1.

**Logic:** 3 total queries regardless of member count. Builds Maps of latest timestamps per member. Updates all members via `Promise.all()` with conditional writes (only updates if the new timestamp is later than the current `last_active_at`). Proxy members are excluded from the scan entirely (`is_proxy = false` filter on the initial member fetch).

### 7.8 Notification Outbox Worker

**Trigger:** Scheduled every 5 minutes.
**Concurrency:** 1.
**Batch size:** 50 stale deliveries per run.

**Logic:**
- `staleThreshold = now - 5 minutes`
- Fetches up to 50 `notification_deliveries` in `pending` or `failed` state for non-in_app channels created before the threshold.
- Join: `notification_deliveries → notifications → workspace_members → users` — pulls all data needed to reconstruct the job payload in a single query.
- For each: skips proxy members, re-enqueues to `notification-queue`, resets status to `pending`.
- Individual failures in the loop are caught and logged without stopping the scan.

**Why this exists:** If `notification.send()` calls `queue.add()` and Redis is temporarily unavailable, the add fails. The delivery row is marked `failed`. Without the outbox, that notification is lost. The outbox closes this gap.

### 7.9 Data Export Worker

**Trigger:** `POST /v1/auth/data-export`.
**Payload:** `{ userId, userEmail, workspaceIds }`
**Concurrency:** 2 — exports are I/O heavy and memory-bound; higher concurrency risks OOM.

**Logic:**
1. Fetch user profile (`id`, `email`, `full_name`, `country_of_residence`, `timezone`, `preferred_language`, `created_at`).
2. Fetch ledger entries: `WHERE contributor_id = userId AND workspace_id IN workspaceIds` — ordered by `recorded_at DESC`. Joins to `containers` and `workspaces` for names.
3. Fetch member IDs: `WHERE user_id = userId AND workspace_id IN workspaceIds AND is_active = true`.
4. Fetch tasks: `WHERE assigned_to IN memberIds AND deleted_at IS NULL` — ordered by `created_at DESC`. Joins to `containers` for name.
5. Build two CSVs using the `escape()` helper (handles quotes in field values).
6. Email via Resend with both files as Base64 attachments.
7. If Resend is unconfigured: logs warning, returns cleanly (no error thrown to BullMQ).

**CSV schemas:**
- Contributions: Workspace, Container, Type, Amount, Currency, Base Amount, Payment Method, Status, Note, Recorded At, Confirmed At
- Tasks: Container, Title, Status, Due Date, Completed At, Completion Note, Created At

---

## 8. Real-Time & Event Handling

### 8.1 Notification Badge Polling

Kith does not implement WebSocket or Server-Sent Events. Real-time notification badge updates use client-side polling:

- `GET /v1/notifications/count` — returns `{ unread_count: N }`. This is a lightweight query (indexed by `recipient_id, is_read`) designed for frequent polling (every 30–60 seconds).
- `GET /v1/notifications` — full inbox, loaded on initial render and manually on demand.

The `resolveMember` middleware in the notification router performs a DB lookup on every poll request. At scale, this is an optimization candidate (see Section 11).

### 8.2 Push Notifications (FCM)

Firebase Cloud Messaging provides real-time device alerts:

1. App registers token: `POST /v1/auth/push-token` with `{ token, platform }` (platform: `android`, `ios`, `web`).
2. Token stored on `users.push_token` + `users.push_token_platform`. `users.push_enabled` defaults to `true`.
3. Worker sends via `messaging.send()`. FCM payload includes:
   - `notification: { title, body }` — shown in the OS notification tray
   - `data: { reference_type, reference_id, workspace_id, notification_id }` — used by the app for deep-linking
   - For `platform === 'web'`: adds `webpush.notification.icon = '/icons/icon-192.png'`
4. **Token rotation guard:** Before sending, the worker re-reads `users.push_token` from DB. If the stored token differs from the one in the job payload (user logged in on a new device since the job was enqueued), the delivery is marked `skipped` — not `failed`. This prevents delivering to a stale token.
5. **Unconfigured FCM:** `getMessaging()` returns `null`. Worker marks delivery `skipped` (not `failed`). The DLQ is not polluted with permanent failures from missing configuration.

### 8.3 Email Notifications (Resend)

Used for push channel fallback and for the data export feature.

The HTML email template is a minimal inline-styled layout:
```
div (max-width: 600px, centered, padded)
  h2 → title
  p → body
  hr
  p → "Kith — Family Finance Coordinator"
```

Email sender is `EMAIL_FROM` env var (default: `Kith <noreply@kith.app>`).

**Unconfigured Resend:** `getResend()` returns `null`. Worker marks delivery `skipped`. Data export worker logs a warning and returns cleanly.

### 8.4 Identified Gap: No Real-Time Dashboard Updates

If an admin confirms a contribution while a member is actively viewing the contribution list, the member's view does not update until they navigate away and back. This is a known product limitation. See Section 15 for the recommended fix.

---

## 9. Multi-User / Team Architecture

### 9.1 Workspace Isolation — Enforcement Layers

**Layer 1 — Middleware (every request):**
`requireMembership` verifies `workspace_members WHERE workspace_id = :workspaceId AND user_id = :userId AND is_active = true AND deleted_at IS NULL`. Not found → 404. This runs before every single workspace-scoped route handler.

UUID format validation is performed before the DB query — malformed IDs return 404 immediately without a DB round trip.

**Layer 2 — All DB queries include `workspace_id`:**
Every controller query scopes to `req.params.workspaceId`. There is no global cross-workspace query path for authenticated user actions.

**Layer 3 — Supabase RLS (defense in depth):**
The backend uses the service role key (bypasses RLS), but RLS policies are still defined. If any code path accidentally uses the anon key, RLS enforces workspace isolation at the DB level.

### 9.2 Role Enforcement Matrix

| Route | Middleware | Notes |
|---|---|---|
| GET /workspace | requireMembership | All members |
| PATCH /workspace | requireMembership + requireAdmin | Admin only |
| GET /members | requireMembership | All members; response filtered by role |
| PATCH /members/:id | requireMembership + requireSelfOrAdmin() | Self or admin; field restrictions in controller |
| DELETE /members/:id | requireMembership + requireAdmin | Admin only; last-admin guard in controller |
| POST /ledger | requireMembership | Member: own; Admin: any contributor |
| POST /ledger/:id/confirm | requireMembership + requireAdmin | Admin only |
| GET /disputes | requireMembership + requireAdmin | Admin only |
| POST /disputes/:id/note | requireMembership | Any member (conversation thread) |
| POST /disputes/:id/resolve | requireMembership + requireAdmin | Admin only |
| GET /audit-log | requireMembership + requireAdmin | Admin only |
| GET /milestones/:id | requireMembership | All members (no requireAdmin) |
| DELETE /tasks/:id | requireMembership + requireAdmin | Admin only |
| PATCH /tasks/:id/status | requireMembership + requireAdmin | Admin only (hard override) |

### 9.3 Data Scoping Rules

| Resource | Admin sees | Member sees |
|---|---|---|
| Ledger entries | All entries in workspace/container | Only their own (`contributor_id = req.member.id`) |
| Container summary | Full amounts per participant | Own financial details + status indicators for others |
| Member profile | All fields including `admin_notes`, `last_active_at` | Most fields; `admin_notes` stripped |
| Task list | All tasks in container | Only tasks assigned to them |
| Disputes list | All disputes in workspace | Only their own |
| Audit log | Full log | Not accessible (requireAdmin) |
| Dashboard pending confirmations | Populated | Omitted |
| Workspace settings | Full access | Not accessible (requireAdmin) |
| Member engagement analytics | Full | Not accessible (requireAdmin) |
| Profile history | Full | Not accessible (requireAdmin) |
| Contribution summary | Any member's | Own only (enforced via requireSelfOrAdmin in route + additional check in controller) |

### 9.4 Proxy Member Handling

Proxy members interact with the system exclusively through their managing admin:

1. **Creation:** `POST /v1/workspaces/:workspaceId/members` with `is_proxy: true`, `proxy_managed_by: <adminMemberId>`.
2. **Ledger entries:** Admin submits with `contributor_id = proxyMember.id`. The controller verifies caller is admin. A `proxy_actions` record is inserted for audit: `{ entry_id, proxy_member_id, recorded_by_admin_id, action: 'ledger_entry_created' }`.
3. **Notifications:** In `notification.send()`, `_sendToRecipient` checks `recipient.is_proxy`. If true, all external channels (push, email) are skipped before any delivery record is created. The in-app notification (if any) is created but effectively unreachable since the proxy member cannot log in.
4. **Engagement check:** Proxy members are filtered out of the engagement check worker scan (`is_proxy = false`).

### 9.5 Multi-Workspace Identity

A user has one global identity (`users.id` = Supabase `auth.users.id`) but multiple workspace-local identities:

```
users (global)
  id: abc-123
  full_name: "Emmanuel Okafor"

workspace_members (workspace-scoped)
  user_id: abc-123 | workspace_id: family-pool | display_name: "Dad"    | role: admin
  user_id: abc-123 | workspace_id: community   | display_name: "Treasurer" | role: member
```

`GET /v1/auth/me` returns the global profile plus all active membership summaries. The frontend uses this to build a workspace switcher where the user can navigate between their different group contexts.

The `resolveMember` middleware in notification routes resolves to the most recently joined (`joined_at DESC`) active workspace membership. When notifications are filtered by `workspace_id` query param, the resolution is scoped to that specific workspace.

---

## 10. Edge Cases & System Resilience

### 10.1 Duplicate Ledger Submission (Race Condition)

**Scenario:** User double-taps "Submit" or network retries a POST.

**With idempotency key:** The second request finds the existing entry by key and returns it with `idempotent: true`. Atomic and safe.

**Without idempotency key:** The time-window check (10 minutes, same contributor + amount + container) returns 409 with the `duplicate_entry_id`. The user must explicitly `?force=true` to override. This is a UI-visible speed bump that prevents accidental duplicates.

**Gap:** If two requests arrive simultaneously (true parallel race without idempotency key), both could pass the time-window check (neither exists yet when both check) and both could insert. The only protection in this case is the time-window check running after both have committed — one would then see the other on a subsequent check. A `UNIQUE(workspace_id, idempotency_key)` DB constraint on `ledger_entries` is needed to fully close this.

### 10.2 Atomic State Transitions

**Dispute raise race:** Two requests try to raise a dispute on the same entry simultaneously. The `raise_dispute_atomic` RPC runs in a transaction. The second would either fail on a unique constraint on the dispute (if a `UNIQUE(ledger_entry_id)` constraint exists on open disputes) or create a second dispute. This is a gap — the RPC should validate no open dispute exists inside the transaction.

**Resolve dispute concurrency:** Two admins resolve the same dispute simultaneously. The `resolve_dispute_atomic` RPC's atomic nature means one transaction commits and the other either commits (second resolution) or conflicts depending on DB constraints. The second resolution would create inconsistent state (dispute already resolved). The RPC should check `status = 'open'` inside the transaction.

### 10.3 Last Admin Removal — Three Paths

The last-admin guard is enforced independently in two controllers:

1. **`deleteMember`:** Queries `workspace_members WHERE workspace_id = :wid AND role = 'admin' AND id != :targetId AND is_active = true`. If count = 0, reject.
2. **`updateMember`:** When `role` is being changed to `member`: same count check. If count = 0 after the proposed change, reject.

**Gap:** There is no protection at the account-deletion level. If a user deletes their Supabase Auth account while they are the last admin of one or more workspaces, those workspaces become orphaned. See Section 15.

### 10.4 Invite Accept Race Condition

**Scenario:** Two users attempt to accept the same invite token simultaneously (e.g., the admin forwarded the same link to two people).

**Current protection:** The `acceptInvite` controller checks `used_at IS NULL` before creating the membership. However, this is a read-then-write without a transaction or row lock.

**Risk:** With perfect timing, both requests could read `used_at = null`, both insert `workspace_members` rows, and both update `invite_links.used_at`. The `workspace_members` unique constraint on `(workspace_id, user_id)` would prevent both from being the same user, but two different users could both successfully accept. The link becomes doubly used.

**Fix:** The acceptance logic should be an atomic RPC using `SELECT ... FOR UPDATE` on the invite link row. See Section 15.

### 10.5 Cycle Target Gap for Late-Added Participants

**Scenario:** A participant is added to a recurring container after cycles have already been generated.

**Current behavior:** The cycle generation worker only runs forward from the current state. Past cycles will have no `contributor_targets` rows for the newly added participant.

**Effect:** `getCycleTargets` shows `no_target` or `upcoming` status for those historical cycles. The admin must manually `set-target` for any past cycles where tracking is needed.

### 10.6 Carry-Forward With No Next Cycle

**Scenario:** A recurring container's `recurrence_end` has passed. The final cycle closes. Some members are still unpaid. `carry_forward_unpaid = true`.

**Current behavior:** The lifecycle worker calculates outstanding balances and searches for the next cycle (`status IN ('open', 'upcoming')`). No next cycle exists. The `nextCycle` variable is null. The carry-forward entries are not created. The outstanding balances are silently discarded.

**Impact:** Admins have no system-generated record of the final outstanding debts. The system gives no warning. See Section 15.

### 10.7 Redis Unavailability

**API server behavior:** On startup, Redis failure is logged as a warning ("queues disabled") but the server starts. Rate limiting (in-memory store) is unaffected. Bull Board becomes unavailable. All `queue.add()` calls from controllers and notification service will fail — those errors are caught (delivery marked `failed`).

**Worker behavior:** Workers will fail to process jobs (Redis is unavailable). When Redis recovers, BullMQ workers reconnect automatically and process the backlogged jobs.

**Notification impact:** External notifications are delayed (not lost, because delivery rows remain in `failed` state for the outbox to pick up when Redis recovers). In-app notifications are created synchronously in the DB — unaffected by Redis.

### 10.8 Firebase Unconfigured

`getFirebaseApp()` returns `null` if `FIREBASE_SERVICE_ACCOUNT` env var is absent. `getMessaging()` propagates `null`. In the notification worker, the `null` check (`if (!messaging || !push_token || !push_enabled)`) leads to `status = 'skipped'` — not `failed`. This means the DLQ is not flooded with permanent failures, and the outbox worker doesn't endlessly retry push deliveries that can never succeed.

### 10.9 Supabase Storage Unavailability

Upload URL generation calls `supabase.storage.createSignedUploadUrl()`. If Storage is unreachable, this throws. The error propagates to the `errorHandler` as a 500. The user's primary action (creating a ledger entry) is separate — it is not affected. Only proof upload fails, which the user can retry.

### 10.10 Bull Board Package Not Installed

`app.js` wraps the Bull Board setup in a `try/catch`. If `require('@bull-board/api')` throws (package not installed), the error is caught and logged as a warning. The server starts normally. The queue monitoring UI is simply unavailable.

---

## 11. Performance & Scalability Thinking

### 11.1 Hot Query Paths & Their Optimization Status

| Query | Frequency | Current Approach | Scale Concern |
|---|---|---|---|
| `requireMembership` | Every workspace request | 2 queries: workspace_members + workspaces | At scale: cache member+workspace combo in Redis with short TTL |
| `GET /notifications/count` | Every 30-60s per active user | Indexed query on `(recipient_id, is_read)` | No concern up to 100k users |
| `GET /dashboard` | On every workspace view | 7 parallel queries, all limited/indexed | Dashboard response cache (30s TTL) at scale |
| `GET /container/summary` | On container view | 3 queries: participants + targets + ledger | Acceptable up to 500 participants per container |
| `notification.send()` loop | Per notification event | Sequential per-recipient queries | Scale bottleneck at 100+ recipients (see below) |

### 11.2 N+1 Query Analysis

**Fixed N+1s** (documented in source with "Batch improvement" comments):
- `createEngagementCheckWorker`: Previously 2N queries → now 3 total.
- `createCycleGenerationWorker`: Previously per-cycle override lookups → now pre-fetched into Maps.
- `createCycleLifecycleWorker`: `cycle_started` notification now fetches per-participant targets in one query per cycle rather than per participant.

**Remaining N+1 risk:**
- `notification.send()` calls `_sendToRecipient(recipientId)` in a loop, issuing a DB query per recipient. For `admin_announcement` with 50+ members, this is 50+ sequential queries.
- **Fix:** Batch-fetch all recipient records before the loop. Pass user data into `_sendToRecipient` instead of re-querying.

### 11.3 Critical Index Requirements

```sql
-- workspace_members: membership verification on every request
CREATE INDEX idx_wm_user_workspace_active
  ON workspace_members(user_id, workspace_id)
  WHERE is_active = true AND deleted_at IS NULL;

-- ledger_entries: container-scoped filtered queries
CREATE INDEX idx_le_container_contributor_status
  ON ledger_entries(container_id, contributor_id, status);
CREATE INDEX idx_le_workspace_status_recorded
  ON ledger_entries(workspace_id, status, recorded_at DESC);

-- notifications: badge count + inbox queries
CREATE UNIQUE INDEX idx_notif_dedup ON notifications(recipient_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_notif_recipient_read_created
  ON notifications(recipient_id, is_read, created_at DESC);

-- notification_deliveries: outbox scan
CREATE INDEX idx_nd_status_channel_created
  ON notification_deliveries(status, channel, created_at)
  WHERE channel != 'in_app';

-- contributor_targets: current target lookup
CREATE INDEX idx_ct_participant_current
  ON contributor_targets(container_participant_id, is_current)
  WHERE is_current = true;

-- container_cycles: lifecycle worker scans
CREATE INDEX idx_cc_container_status_start
  ON container_cycles(container_id, status, cycle_start);
CREATE UNIQUE INDEX idx_cc_container_cycle_start
  ON container_cycles(container_id, cycle_start);  -- for upsert conflict target

-- container_tasks: assigned task queries
CREATE INDEX idx_task_assigned_status
  ON container_tasks(container_id, assigned_to, status)
  WHERE deleted_at IS NULL;

-- audit_log: paginated workspace activity
CREATE INDEX idx_audit_workspace_created
  ON audit_log(workspace_id, created_at DESC);

-- pool_cycle_overrides: generation worker batch fetch
CREATE INDEX idx_pco_container ON pool_cycle_overrides(container_id);
```

### 11.4 Rate Limiting Architecture

**Current implementation:** All rate limiters use the **in-memory store** (not Redis). This is documented in the source code with a comment:
```javascript
const store = undefined; // Use default memory store
```

**Implication:** Rate limits are per-process, not per-deployment. In a horizontally scaled deployment with N API server instances, a single IP can make `N × 200` requests per minute before being limited. The in-memory store works correctly for single-instance deployments.

**Configured limits:**
- `generalLimiter`: 200 requests/minute per IP (all authenticated routes)
- `authLimiter`: 5 requests/minute per IP (auth routes only)
- `inviteLimiter`: 10 requests/hour per IP (invite acceptance)
- `uploadLimiter`: 20 requests/hour per user (upload URL generation)

**Note:** `skip: (req) => process.env.NODE_ENV === 'test'` — rate limiters are disabled in test environments.

### 11.5 BullMQ Concurrency Rationale

| Worker | Concurrency | Rationale |
|---|---|---|
| notification-queue | 10 (+ rate 50/sec) | Parallelizes FCM + Resend calls; rate limiter prevents external service throttling |
| cycle-generation-queue | 5 | Multiple containers can generate simultaneously; each job is I/O-bound |
| data-export-queue | 2 | I/O-heavy and memory-bound CSV generation; low concurrency prevents OOM |
| All others | 1 | Serial scans prevent conflicting state transitions and duplicate notifications |

### 11.6 Supabase Admin Client

The `supabaseAdmin` singleton uses the service role key and Supabase's built-in connection pooling. For production at scale, consider using `pg` (node-postgres) directly with explicit pool sizing (`max: 10` for API, `max: 5` for workers) and optionally Supabase's built-in PgBouncer in transaction mode for connection saturation prevention.

---

## 12. Flexibility & Extensibility

### 12.1 Adding a New Container Type

The `container_type` enum has `event` and `recurring`. Adding `savings_goal` (a target amount tracked over time, no fixed recurrence):
1. Add enum value to DB.
2. Update `createContainerSchema` Zod validator.
3. Add type-specific controller logic in `createContainer` / `getContainer` / `getSummary`.
4. No middleware changes needed.

### 12.2 Adding a New Notification Type

The template registry is a plain JS object in `notification.service.js`. Adding a new type:
1. Add entry to `TEMPLATES` with `title`, `body`, `channels`.
2. Call `notification.send({ type: 'new_type', ... })` at the trigger point.
3. No schema changes unless a new `reference_type` value is needed.

### 12.3 Adding a New Background Job

1. Add the queue name to `QUEUE_NAMES` in `src/queues/index.js`. (Documented: the `data-export-queue` was missing and caused a runtime crash at the `requestDataExport` endpoint — this is the exact error that Issue 21 fixed.)
2. Create a `create{Name}Worker()` function following the pattern in `background_workers.js`.
3. Start the worker in the worker entry point.

### 12.4 Adding Server-Side Currency Conversion

Currently the client provides `base_amount`. To add server-side conversion:
1. Integrate an FX rate API (Open Exchange Rates, Fixer.io).
2. Cache rates in Redis with an hourly TTL.
3. If `base_amount` is absent in the ledger entry request: call `convertCurrency(originalAmount, originalCurrency, workspace.baseCurrency)`.
4. No schema changes needed (`base_amount` already exists).

### 12.5 Stripe Payment Integration

The current system tracks contributions but does not process payments. The existing ledger model maps cleanly to Stripe:
1. Add `payment_intent_id` to `ledger_entries`.
2. Create `POST /.../ledger/pay` → creates a Stripe PaymentIntent.
3. Handle Stripe webhooks → on `payment_intent.succeeded`: confirm the ledger entry.
4. The `confirmEntry` controller flow remains unchanged.

### 12.6 Real-Time Layer (Supabase Realtime)

The `audit_log` table is a structured event stream. To add real-time updates:
1. Enable Supabase Realtime on `audit_log`, `ledger_entries`, `notifications`.
2. Frontend subscribes: `supabase.channel('workspace-events').on('postgres_changes', { table: 'ledger_entries', filter: `workspace_id=eq.${workspaceId}` }, handler).subscribe()`.
3. This closes the "stale dashboard" gap without adding WebSocket infrastructure.

### 12.7 Adding New File Upload Categories

`storage.service.js` has `MAX_SIZES` and `ALLOWED_TYPES` keyed by category string. Adding `budget_document`:
1. Add `'budget_document'` entry to both maps.
2. Create a route using the two-step upload pattern.
3. No other changes needed.

---

## 13. UX & Product Thinking

### 13.1 Why the Two-Step Upload Pattern

The alternative — multipart upload through the Express server — would:
- Force large files (up to 50MB for outcome files) through the API server's memory
- Create a bottleneck on the API server for file transfer bandwidth
- Require streaming middleware and more complex error handling

The two-step approach means the API server only handles metadata (a few hundred bytes). The file transfer goes directly from client to Supabase Storage. The tradeoff is UI complexity: the client makes three calls instead of one. For a family finance app where proof uploads are occasional (not a primary flow), this tradeoff is appropriate.

The 300-second (5-minute) expiry on signed upload URLs is generous enough for slow mobile connections uploading bank screenshots.

### 13.2 Why 404 Instead of 403 for Workspace Access

Returning 403 when a user is not a member of a workspace would reveal that the workspace exists. An attacker could enumerate workspace IDs and discover active groups. By returning 404, the system makes no distinction between "does not exist" and "you have no access," eliminating workspace enumeration as an attack vector.

### 13.3 Why In-App Notifications Are Synchronous

In-app delivery is a DB insert — fast and always succeeds. If it were queued:
- There would be a delay between the action and the notification appearing in the inbox
- The inbox count (`/notifications/count`) would briefly show stale data

External channels (push, email) are queued because they involve external API calls that may be slow, fail, or rate-limited. The asymmetry is intentional: in-app delivery should feel instant because it is instant.

### 13.4 Why Proxy Members Are a First-Class Concept

The naive alternative — having admins record "on behalf of [name]" with a note field — loses:
- The ability to assign individual contribution targets to that person
- Per-person history in the contribution summary
- The ability to generate accurate per-person progress reports
- The ability to assign tasks to that person in the task system

Real families include people who cannot use a smartphone app. Making them second-class in the data model would make the app less accurate for its target users.

### 13.5 Why There's No "Rejected" Status

This is a gap, not a product decision. The current ledger status lifecycle (`pending → proof_uploaded → confirmed → disputed`) lacks a `rejected` terminal state for contributions that an admin definitively wants to void. The workaround (raise dispute → resolve with a rejection note) is semantically overloaded and confusing. See Section 15.

### 13.6 Why Dispute Notes Are Not Admin-Only

The dispute mechanism is modeled as a conversation thread. The member who raised the dispute (or whose contribution is disputed) should be able to provide context, additional information, or corrections in the same thread. Making notes admin-only would force members to use external channels (WhatsApp, phone) for this conversation, which defeats the purpose of having structured dispute management in the platform.

### 13.7 Display Name Is Workspace-Scoped by Design

A user may present differently in different contexts: "Dad" in the immediate family workspace, "Treasurer" in the extended family pool, and "Emmanuel O." in a diaspora community workspace. The `display_name` on `workspace_members` captures this naturally. The global `users.full_name` is the legal or registered name; the workspace `display_name` is the social name within that group.

---

## 14. Non-Happy Paths

### 14.1 Member Tries to Submit Ledger Entry Without Being a Participant

**Error path:** `createEntry` controller fetches `container_participants WHERE workspace_member_id = contributor_id AND container_id = :containerId`. Not found → 403 with message: "You are not a participant in this container."

Found but `money_enabled = false` → 403 with message: "Money tracking is not enabled for you in this container. Please ask an admin to enable it."

### 14.2 Member Submits Proof for Already-Confirmed Entry

**Error path:** `confirmProof` controller checks entry status. If `confirmed`: the proof can still be added (proofs are just appended to the JSONB array), but the status does not change back to `proof_uploaded`. The entry remains `confirmed`. This is intentional — a member may want to upload their bank statement for record-keeping after confirmation.

### 14.3 Admin Tries to Delete a Member with Confirmed Ledger Entries

**Error path:** `deleteMember` checks if the target has any confirmed entries. If yes: `is_active = false` + `deleted_at = now()` (soft delete). The member's ledger history is preserved. They appear in the UI as "inactive" but their contributions still count toward container totals.

Hard deletion requires `?force=true` AND no confirmed entries. If both conditions are met: the `workspace_members` row is hard-deleted. If the member has tasks assigned to them, those tasks become `assigned_to = null` (orphaned). This is a gap — see Section 15.

### 14.4 Login Before Email Verification

**Error path:** Supabase returns "Email not confirmed" error on `signInWithPassword`. `mapSupabaseAuthError` catches this specific error string and throws `BusinessRuleError("Please verify your email address before logging in. Check your inbox for a verification link.")` with HTTP 403. The client should display this message and optionally offer a "Resend verification email" button.

### 14.5 Notification Queue Unavailable During Ledger Confirmation

**Scenario:** Admin confirms a contribution. The primary DB write succeeds. `notification.send()` is called. `queue.add()` fails because Redis is temporarily unavailable.

**Error path:** `notification.send()` catches the queue error. The `notification_deliveries` row is already inserted with `status='pending'`. The update to `status='failed'` is attempted. The primary response (HTTP 200 with confirmed entry) is already sent to the admin.

**Recovery:** The outbox worker (running every 5 minutes) scans for `status IN ('pending', 'failed')` deliveries older than 5 minutes. When Redis recovers, it re-enqueues the delivery. The notification is sent with at most a 5-minute delay.

### 14.6 Data Export Worker Failure (All Retries Exhausted)

**Scenario:** The export worker crashes for all 3 retry attempts (e.g., Supabase is consistently unavailable, or Resend throws on every attempt).

**Current behavior:** The job goes to BullMQ's failed queue. The user receives no notification. They submitted a `POST /data-export` request, saw "export queued," and then never received the email.

**Gap:** No failure notification to the user. No mechanism for the user to check export status. See Section 15.

### 14.7 Cycle Generation Worker Encounters Partial Failure

**Scenario:** The cycle generation worker runs, successfully creates 3 cycles, then fails on the 4th due to a transient DB error. BullMQ retries the entire job.

**Recovery:** Because cycle creation uses `{ ignoreDuplicates: true }` on the unique `(container_id, cycle_start)` constraint, re-running the job from the beginning skips already-created cycles. The worker continues from where it would logically next generate, effectively completing the generation. This is a deliberate idempotency design — the worker is safe to retry from scratch.

### 14.8 Container Completed but Milestone Insert Fails

**Error path:** `completeContainer` sets container status to `completed`. Then attempts milestone creation. If the milestone INSERT fails (transient DB error, invalid data), the exception is caught:
```javascript
try {
  await createMilestone({ ... });
} catch (err) {
  logger.error('Failed to auto-create milestone', { error: err.message });
}
```
The container completion succeeds. The milestone is not created. The error is in logs. Admins can manually create the milestone. This is intentional — milestone creation is a non-critical side effect.

### 14.9 Soft-Deleted Container Restoration

**Flow:** `POST /containers/:containerId/restore` (admin only) sets `deleted_at = null`. Before restoring, the controller verifies:
- Container must be soft-deleted (`deleted_at IS NOT NULL`)
- Container must be in the correct workspace
- Container type-specific invariants are still satisfied

After restoration, the container is `active` again. All historical participants and ledger entries are intact.

### 14.10 Attempt to Hard-Delete Container with Confirmed Entries

**Error path:** `deleteContainer` first checks for any confirmed ledger entries. If found: soft delete only. `?permanent=true` flag is checked only if `force=true` is also provided AND no confirmed entries exist. The error message is explicit: "This container has confirmed financial records and cannot be permanently deleted. Archive it instead."

---

## 15. Missing or Weak Areas

### 15.1 [CRITICAL] No "Rejected" Ledger Entry Status

**Gap:** The ledger status lifecycle has no `rejected` terminal state. Admins who want to definitively reject a fraudulent or incorrect submission must use the dispute mechanism, which is semantically designed for contested entries — not for administrative rejection.

**Impact:** Confusing UX. Dispute resolution notes become the de-facto rejection reason. Rejected entries appear in the member's contribution history with no clear signal that they were rejected.

**Fix:** Add `rejected` to the `ledger_entries` status enum. Add `POST /.../ledger/:entryId/reject` (admin only) with a `rejection_reason` field. Transition logic: `pending` or `proof_uploaded` → `rejected`. Notify the contributor with the reason. Rejected entries remain in history for audit but don't count toward totals.

### 15.2 [CRITICAL] Invite Accept Race Condition

**Gap:** `acceptInvite` reads `used_at`, then writes membership and marks the invite used — without a lock. Two simultaneous accepts from different users could both succeed.

**Fix:** Move acceptance into a PostgreSQL RPC (`accept_invite_atomic`) using `SELECT ... FOR UPDATE` on the `invite_links` row. Checks `used_at IS NULL` and `expires_at > now()` inside the transaction before inserting the membership and marking the invite used.

### 15.3 [HIGH] Rate Limiters Not Shared Across Instances

**Gap:** All rate limiters use the in-memory store. In a horizontally scaled deployment with N API instances, limits are effectively multiplied by N.

**Fix:** Switch to `rate-limit-redis` package with an `ioredis` client connected to the existing Redis instance. One line change per limiter — the API is compatible with `express-rate-limit`.

### 15.4 [HIGH] Workspace Orphaned on Last-Admin Account Deletion

**Gap:** No protection exists at the account-deletion level. If the last admin deletes their Supabase Auth account, the workspace becomes permanently inaccessible (no admin can promote another member).

**Fix:**
- Add `DELETE /v1/auth/account` endpoint. Before processing: check if user is the last admin of any workspace → reject with "Transfer ownership of X workspaces before deleting your account."
- OR: Add `POST /v1/workspaces/:workspaceId/transfer-ownership` that promotes a member to admin and optionally demotes the current owner.

### 15.5 [HIGH] End-of-Recurring-Container Unpaid Balances Silently Dropped

**Gap:** When the final cycle of a recurring container closes and `carry_forward_unpaid = true`, outstanding balances have nowhere to go. They are not carried anywhere and no alert is sent.

**Fix:**
- When closing a cycle with no next cycle: compute outstanding balances and store them in a `final_outstanding_amounts` JSONB column on the container.
- Set container status to `ended` (new status) to distinguish from `archived`.
- Send `overdue_summary_admin` notification to all admins listing the outstanding amounts and prompting next-step action.

### 15.6 [HIGH] No Real-Time Dashboard Updates

**Gap:** Dashboard data is stale after initial load. Members don't see confirmation of their contributions without navigating away and back.

**Fix:** Enable Supabase Realtime on `ledger_entries`, `notifications`, and `container_tasks`. Frontend subscribes to row-level changes scoped to the current workspace. Alternatively: implement a 60-second polling interval for the notification count + a lightweight "workspace state hash" endpoint that changes when any significant write occurs.

### 15.7 [HIGH] No Data Export Failure Notification

**Gap:** If the data export worker fails all retries, the user never knows. They wait indefinitely for an email that will never arrive.

**Fix:** Add a `onFailed` handler in `createDataExportWorker`:
```javascript
worker.on('failed', async (job, err) => {
  await notification.send({ type: 'data_export_failed', recipientIds: [userId], ... });
});
```
Also send an in-app notification + email explaining the failure and providing a retry link.

### 15.8 [MEDIUM] Reminder Worker Only Scans Standing Targets (Not Cycle Targets)

**Gap:** The reminder worker filters `cycle_id IS NULL` — it only sends reminders for standing contribution targets, not for cycle-specific targets in recurring pools. Members in recurring pools only receive `cycle_started` notifications. They receive no follow-up reminders if they haven't contributed as the cycle deadline approaches.

**Fix:** Remove the `cycle_id IS NULL` filter, or add a second pass that scans cycle-specific targets for open cycles whose `cycle_end` is within 7 days or past due.

### 15.9 [MEDIUM] Orphaned Task Assignments on Hard Member Delete

**Gap:** If a member is hard-deleted (`?force=true` + no confirmed ledger entries), any `container_tasks` assigned to them (`assigned_to`) are not updated. The tasks remain with a dangling `assigned_to` reference to a deleted member ID.

**Fix:** In `deleteMember` before hard-deleting: `UPDATE container_tasks SET assigned_to = NULL WHERE assigned_to = :memberId AND deleted_at IS NULL`. Or: add a FK constraint with `ON DELETE SET NULL`.

### 15.10 [MEDIUM] Workspace Settings Schema/Table Mismatch

**Gap:** `workspace_settings` is a key-value table, but the Zod validator in `updateSettingsSchema` defines typed fields (`reminder_templates`, `notification_prefs`, `invite_message`). The table doesn't enforce the structure. Stored values are not validated on read — a corrupted setting value could cause a runtime error in a controller expecting a specific shape.

**Fix (Option A):** Migrate workspace settings to typed columns on the `workspaces` table.
**Fix (Option B):** Add validation in `getSettings` that applies the Zod schema to the retrieved value and returns defaults for any field that fails validation.

### 15.11 [MEDIUM] No Bulk Ledger Confirmation

**Gap:** Admins must confirm entries one by one via `POST /.../ledger/:entryId/confirm`. For a workspace with 50 pending contributions after a monthly cycle, this requires 50 API calls.

**Fix:** Add `POST /v1/workspaces/:workspaceId/ledger/confirm-bulk` (admin only) with `{ entry_ids: [...] }`. Batch UPDATE confirmed + batch notification (one notification per unique contributor, not one per entry).

### 15.12 [MEDIUM] Dispute Raise/Resolve Race Conditions Inside RPC

**Gap:** The `raise_dispute_atomic` RPC does not check whether an open dispute already exists for the entry inside the transaction. Two simultaneous raise requests could create two disputes on the same entry.

Similarly, `resolve_dispute_atomic` does not verify `status = 'open'` inside the transaction. Two concurrent resolves could both commit.

**Fix:** Add pre-condition checks inside both RPCs:
- `raise_dispute_atomic`: `IF EXISTS (SELECT 1 FROM disputes WHERE ledger_entry_id = p_ledger_entry_id AND status = 'open') THEN RAISE EXCEPTION 'dispute_exists'`
- `resolve_dispute_atomic`: `IF (SELECT status FROM disputes WHERE id = p_dispute_id) != 'open' THEN RAISE EXCEPTION 'dispute_not_open'`

### 15.13 [LOW] Group Member Addition Uses Sequential Loop

**Gap:** `createGroup` with `member_ids` may add members via a sequential loop rather than a batch upsert.

**Fix:** Replace with a single `supabaseAdmin.from('group_members').upsert(bulkRows, { ignoreDuplicates: true })`.

### 15.14 [LOW] No Workspace Restore Endpoint

**Gap:** Workspaces have `deleted_at` (soft delete support) but no restore endpoint. An accidentally deleted workspace cannot be recovered via the API.

**Fix:** Add `POST /v1/workspaces/:workspaceId/restore` (admin only, using service-level query since `requireMembership` won't pass for a soft-deleted workspace) that sets `deleted_at = null` if within a configurable grace period (e.g., 30 days).

### 15.15 [LOW] Ledger Export is Workspace-Level but Named Under Containers

**Observation:** `GET /ledger/export` is mounted at the workspace level (not under `/containers/:containerId`), but the route is defined in the containers-and-ledger section of `workspace.routes.js`. This is architecturally correct (workspace-level export) but the route placement may confuse future maintainers.

**Recommendation:** Add a comment in the route file explicitly noting that `GET /ledger/export` is intentionally workspace-scoped and explain that it must be declared at this level (not under `containers/:containerId`) for that reason.

### 15.16 [LOW] `notification_deliveries.retry_count` Increment Implementation

**Current code:** The notification worker increments `retry_count` by:
1. Fetching the current `retry_count` value in a separate query
2. Adding 1
3. Writing the incremented value back

This is a read-modify-write without atomicity — concurrent executions could lose increments. For audit accuracy this matters.

**Fix:** Use a PostgreSQL atomic increment: `UPDATE notification_deliveries SET retry_count = retry_count + 1, last_attempt_at = now() WHERE id = :id`. This eliminates the read-modify-write and is a single round trip.

---

*Kith System Architecture Document · Version 2.0 · April 2026*
*Built from thorough analysis of: app.js · server.js · auth.js · role.js · workspace.js · errorHandler.js · rateLimiter.js · firebase.js · auth_routes.js · workspace_routes.js · invite_routes.js · notification_routes.js · public_routes.js · response.js · background_workers.js · notification_worker.js · data_export_worker.js · index.js (queues)*
*Reference format: SlotWise Backend Architecture Specification v3.0*
