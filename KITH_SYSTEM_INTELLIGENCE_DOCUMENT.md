# 🧾 Kith — Product + System Intelligence Document

> **Document Type:** Startup-Grade Technical Product Intelligence  
> **Purpose:** Single source of truth for AI agents, developers, investors, and technical reviewers  
> **Source of Truth:** 100% derived from actual codebase — no hallucinated behavior  
> **Codebase Analyzed:** 20 files — routes, controllers, queue registry, scheduler  

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [System Architecture](#2-system-architecture)
3. [Feature Inventory](#3-feature-inventory)
4. [Endpoint Analysis](#4-endpoint-analysis)
5. [User Flows & Workflows](#5-user-flows--workflows)
6. [Data Models & System Relationships](#6-data-models--system-relationships)
7. [WebSocket / Real-Time Systems](#7-websocket--real-time-systems)
8. [AI Systems](#8-ai-systems)
9. [Product & UX Intelligence](#9-product--ux-intelligence)
10. [Risks & Technical Debt](#10-risks--technical-debt)
11. [Startup & Portfolio Analysis](#11-startup--portfolio-analysis)
12. [Future Evolution](#12-future-evolution)

---

## 1. Product Overview

### What is Kith?

**Kith** is a collaborative workspace platform for **group financial contribution tracking and task management**. It is purpose-built for groups — families, community organizations, savings circles, investment clubs, or cooperative groups — who need to track who contributed what, when, and whether their commitments were fulfilled.

The product name "Kith" (from "kith and kin") strongly signals a **family and trusted-circle positioning** — the admin board even uses the realm `"Kith Admin"`.

### Core Purpose

Kith solves a painful, underserved problem: **transparent, verifiable collective contribution management**. When groups pool money (for events, recurring savings, shared investments, communal projects), they typically rely on spreadsheets, WhatsApp messages, or memory. Kith replaces this with a structured, auditable, proof-backed system.

The product sits at the intersection of:
- **Group financial coordination** (ajo/susu/chit-fund style rotating pools)
- **Event contribution tracking** (wedding, funeral, celebrations)
- **Task accountability** (chore systems, organizational deliverables)
- **Family/community group management**

### Target Users

| Role | Description |
|---|---|
| **Admin** | Group organizer who creates workspaces, manages members, confirms contributions, resolves disputes. Typically the "treasurer" or group leader. |
| **Member** | Participant who submits contributions with proofs, completes tasks, and receives notifications. |
| **Proxy Member** | A record representing a person who isn't digitally active — contributions are logged on their behalf by admins. |

### Main Value Proposition

1. **Proof-backed contributions** — Contributors upload payment receipts; admins confirm. No dispute without evidence.
2. **Full audit trail** — Every admin action is logged with actor, timestamp, and metadata.
3. **Recurring pool management** — Automatic cycle generation for weekly/monthly contribution pools with carry-forward logic for missed payments.
4. **Dispute resolution system** — Formal dispute lifecycle (raise → note → resolve) with atomic database operations to prevent inconsistent state.
5. **Multi-workspace** — One user can belong to multiple groups, each with isolated members, containers, and ledgers.
6. **Public sharing** — Containers can be shared publicly via a token link for read-only contribution progress views.
7. **GDPR compliant** — Full data export capability as an async job.

### Technical Uniqueness

- **Atomic PostgreSQL RPCs** for critical state transitions (raise dispute, resolve dispute, convert container, create workspace) — prevents orphaned or inconsistent records
- **Idempotency key support** on ledger entry creation — prevents duplicate contributions on network retries
- **Duplicate contribution detection** — 10-minute window check on same contributor/amount to surface likely double-submissions
- **BullMQ queue architecture** with 9 named queues and 7 scheduled cron jobs covering every major async concern
- **Proxy member model** — enables tracking contributions for non-digital participants
- **Target supersession chain** — contributor targets have a `superseded_by` linked list for full history

### Startup / Business Potential

Kith is a **niche-vertical fintech SaaS** targeting communities where collective finance is deeply cultural (West African, South Asian, Caribbean diaspora communities who run ajo/susu/chit-fund circles; family savings groups; community organizations). This is a large, underserved market with high retention — once a group migrates, switching costs are very high because historical ledger data is embedded.

---

## 2. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Clients                             │
│           (Mobile App / Web App / Browser Extension)        │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS + Bearer JWT
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Express.js API Server                     │
│                    (app.js — v1 prefix)                     │
│                                                             │
│  Middleware Stack:                                           │
│  helmet → cors → compression → json → requestId →           │
│  requestLogger → generalLimiter → cookieParser              │
│                                                             │
│  Route Groups:                                              │
│  /v1/auth          → auth.routes.js                         │
│  /v1/public        → public.routes.js                       │
│  /v1/invites       → invite.routes.js (legacy compat)       │
│  /v1/workspaces    → workspace.routes.js (scoped)           │
│  /v1/notifications → notification.routes.js                 │
│  /admin/queues     → Bull Board (IP + Basic Auth guarded)   │
└──────────┬──────────────────────────┬───────────────────────┘
           │                          │
           ▼                          ▼
┌──────────────────┐       ┌─────────────────────────┐
│   Supabase       │       │   Redis (BullMQ)         │
│                  │       │                          │
│  - PostgreSQL DB │       │  Queues:                 │
│  - Auth (JWT)    │       │  notification-queue      │
│  - Storage       │       │  reminder-queue          │
│  - RPC functions │       │  cycle-generation-queue  │
└──────────────────┘       │  cycle-lifecycle-queue   │
                           │  task-overdue-queue      │
                           │  invite-cleanup-queue    │
                           │  engagement-check-queue  │
                           │  notification-outbox-queue│
                           │  data-export-queue       │
                           └─────────────────────────┘
```

### Backend Architecture

- **Framework:** Express.js (Node.js)
- **Security:** Helmet, CORS with origin whitelist, rate limiting (general + auth + upload + invite-specific limiters), trust proxy for accurate IP
- **Auth:** Supabase Auth — JWT-based with `supabaseAuth` (anon key) for user-facing flows and `supabaseAdmin` (service role key) for server-side operations. Refresh tokens stored as `httpOnly` cookies scoped to `/v1/auth/refresh`
- **Database:** Supabase/PostgreSQL accessed exclusively via `supabaseAdmin` SDK. Critical multi-step operations use PostgreSQL RPCs for atomicity
- **Storage:** Supabase Storage — signed upload URLs generated server-side; clients upload directly to Supabase Storage. Separate folders for avatars, proofs, outcomes, covers, milestones, workspace-avatars
- **Async Jobs:** BullMQ with Redis connection — 9 named queues, lazily initialized from a central registry
- **Scheduling:** BullMQ repeatable jobs (cron-based) registered into their target queues — a correct architectural pattern ensuring workers process their own queue's scheduled jobs

### Service Layer

| Service | Responsibility |
|---|---|
| `audit.service` | Logs structured audit events to `audit_log` table — actor, action, target, metadata |
| `notification.service` | Sends in-app notifications; manages outbox for external channel delivery (push/email) |
| `storage.service` | Generates signed upload and download URLs for Supabase Storage |
| `export.service` | Produces CSV exports for ledger entries and tasks |

### Middleware Stack

| Middleware | Purpose |
|---|---|
| `requireAuth` | Validates Supabase JWT from `Authorization: Bearer` header |
| `loadDbUser` | Fetches `users` row from DB and attaches as `req.dbUser` |
| `requireMembership` | Verifies caller has active, non-deleted membership in `workspaceId` |
| `requireAdmin` | Checks `req.member.role === 'admin'`; rejects non-admins |
| `requireSelfOrAdmin()` | Parameterized — passes if caller is the target member OR an admin |
| `requestId` | Injects `X-Request-Id` header for request tracing |
| `requestLogger` | Structured request/response logging |
| `generalLimiter` | Global rate limiter applied to all routes |
| `authLimiter` | Stricter limiter on auth endpoints (signup, login, etc.) |
| `uploadLimiter` | Separate limiter on file upload URL generation |
| `inviteLimiter` | Separate limiter on invite acceptance |
| `errorHandler` | Global error handler; maps typed errors to HTTP codes |

### Queue Architecture (BullMQ)

All 9 queues are registered in a central `queues/index.js` registry with name validation — unknown queue names throw at `getQueue()` call-time, preventing typo-based queue proliferation.

| Queue Name | Purpose | Trigger |
|---|---|---|
| `notification-queue` | Delivers in-app notifications | notification.service calls |
| `reminder-queue` | Scans for upcoming deadlines; sends reminder notifications | Daily 07:00 UTC cron |
| `cycle-generation-queue` | Generates future cycles for recurring containers | On container creation + Daily 03:00 UTC cron |
| `cycle-lifecycle-queue` | Opens/closes cycles based on dates | Daily 00:01 UTC cron |
| `task-overdue-queue` | Marks overdue tasks, notifies assignees | Daily 06:00 UTC cron |
| `invite-cleanup-queue` | Purges expired invite links | Daily 02:00 UTC cron |
| `engagement-check-queue` | Evaluates member engagement levels | Weekly Sunday 06:00 UTC |
| `notification-outbox-queue` | Retries stuck external channel deliveries (push/email) | Every 5 minutes |
| `data-export-queue` | Async GDPR data export → email to user | On-demand via API |

---

## 3. Feature Inventory

### 3.1 Authentication & Identity

**Email/Password Registration**
- Creates Supabase auth user, sends verification email
- Immediately upserts `users` row with profile data
- Returns session tokens if email is auto-confirmed; otherwise returns 201 with "check email" message

**Email Login**
- Validates credentials via Supabase
- Fetches full user profile + all active workspace memberships
- Sets `httpOnly` refresh_token cookie scoped to `/v1/auth/refresh`
- Returns `access_token`, `expires_in`, user object, and shaped memberships array

**Token Refresh**
- Reads refresh token from `httpOnly` cookie
- Exchanges with Supabase for new session
- Rotates cookie with new refresh token

**Google OAuth**
- Step 1: `GET /auth/google/url` — returns Supabase-generated OAuth redirect URL
- Step 2: `POST /auth/google/callback` — exchanges authorization code for session, upserts user profile from Google metadata

**Email Verification**
- `POST /auth/verify-email` — accepts `token_hash` OTP from verification email, returns new session tokens

**Logout (single + all devices)**
- Single: invalidates current session via `supabaseAdmin.auth.admin.signOut(userId)`
- All devices: uses `'global'` scope to revoke all sessions for the user
- Both clear the `refresh_token` cookie

**Password Reset**
- `POST /auth/forgot-password` — always returns success (prevents email enumeration)
- `POST /auth/reset-password` — requires active recovery JWT (from email link); updates password via admin SDK

**Profile Management**
- `GET /auth/me` — returns user + all active memberships (uses `req.dbUser` already populated by middleware — avoids duplicate DB round-trip)
- `PATCH /auth/profile` — updates bio, name, country, timezone, avatar_url, language, notification preferences
- `POST /auth/avatar/upload-url` — generates signed Supabase Storage upload URL for avatar

**Contact Management**
- Individual CRUD: `GET`, `POST`, `DELETE /auth/contacts/:contactId`
- Bulk replace: `PATCH /auth/contacts` — deletes existing contacts of provided types then batch-upserts new ones
- Atomic primary contact upsert via `upsert_primary_contact` RPC to prevent TOCTOU race condition on `is_primary` flag

**Push Notification Registration**
- `POST /auth/push-token` — stores FCM token + platform in `users` table

**Notification Preferences**
- `PATCH /auth/notification-preferences` — toggles `push_enabled` and `email_digest_enabled`

**GDPR Data Export**
- `POST /auth/data-export` — enqueues async job in `data-export-queue` with userId, email, and all workspace IDs. Result is emailed to user.

---

### 3.2 Workspace Management

**List / Create Workspaces**
- `GET /v1/workspaces` — returns all active memberships for the caller
- `POST /v1/workspaces` — creates workspace + initial admin membership in a single atomic `create_workspace_with_admin` RPC

**Workspace CRUD**
- `GET /:workspaceId` — fetch workspace record + current member context
- `PATCH /:workspaceId` — update name, description, currency, visibility (admin only)
- `DELETE /:workspaceId` — soft-delete via `deleted_at` timestamp (admin only)

**Workspace Settings (Key-Value Store)**
- Settings are stored as `(workspace_id, setting_key, setting_value)` rows in `workspace_settings`
- `GET /settings` — returns all settings as a flat object
- `PATCH /settings` — batch-upserts changed settings; writes audit log

**Dashboard**
- `GET /dashboard` — parallel-fetches 7 data sources:
  1. Member count, admin count, proxy count
  2. Active event containers with progress percentages and days-until
  3. Active recurring pools with current cycle
  4. Upcoming contribution deadlines (next 14 days)
  5. Pending confirmations (admin-only)
  6. Recent activity (last 10 audit log entries, human-readable descriptions)
  7. Unread notification count

**Cross-Entity Search**
- `GET /search?q=<query>` — searches members (by display_name) and containers (by name) in parallel via `ilike`
- Results typed as `{ type: 'member' | 'container', ... }` for client-side differentiation

**Admin Broadcast**
- `POST /announce` — sends `admin_announcement` notification to all (or role-filtered) active members
- Validated via `announceSchema`; audited with recipient count

**Audit Log**
- `GET /audit-log` — paginated, filterable by action, actor, date range (admin only)
- `GET /audit-log/export` — CSV download up to 10,000 rows (admin only)

**Overdue Summary**
- `GET /overdue-summary` — joins participants → contributor_targets → ledger to compute per-member outstanding amounts across all active money-enabled containers (admin only)

**Workspace Avatar**
- `POST /avatar-upload-url` — generates signed upload URL in `workspace-avatars/` folder (admin only)

---

### 3.3 Member Management

**List Members**
- Filterable by role, is_proxy, search (display_name ilike); sortable
- Admin sees: `admin_notes`, `last_active_at`, `contribution_streak_months`, email, country, timezone
- Member sees: limited public fields (sensitive admin fields stripped)
- Returns meta counts: total, admins, proxies, active

**Create Member (Proxy)**
- Admin can create proxy members (without a Supabase user account) to represent offline participants
- Validates `proxy_managed_by` must be an active admin

**Get Member**
- Fetches member + joined user profile fields

**Update Member**
- Admin fields: role, is_proxy, proxy_managed_by, is_active, admin_notes, relationship_category
- Member-editable fields: display_name, relationship_to_head, date_of_birth
- Optimistic locking via `version` (matches `updated_at`)
- Last-admin guard: cannot demote the only admin
- Every changed field is recorded in `member_profile_audit` table

**Delete Member**
- Soft-delete (set `deleted_at`, `is_active: false`) by default
- Hard-delete (`force=true`) only if no confirmed ledger entries
- Last-admin guard

**Profile History**
- `GET /:memberId/profile-history` — returns all `member_profile_audit` entries for a member (admin only)

**Contribution Summary**
- `GET /:memberId/contribution-summary` — aggregates ledger entries into per-container paid/target/status breakdown

**Engagement Report**
- `GET /members/engagement` — per-member engagement level (active/quiet/inactive) based on last contribution, task completion, and `last_active_at`

---

### 3.4 Groups

Groups are named collections of members within a workspace, used for bulk-adding participants to containers.

- `GET /groups` — lists all groups with inline member list (any member can see)
- `POST /groups` — create group with optional initial members (admin)
- `GET /groups/:groupId` — full group detail with relationship data
- `PATCH /groups/:groupId` — rename or change description (admin)
- `DELETE /groups/:groupId` — hard delete group (admin)
- `POST /groups/:groupId/members` — add multiple members; skips non-members and already-added (admin)
- `DELETE /groups/:groupId/members/:memberId` — remove member from group (admin)

---

### 3.5 Invite System

Invites are single-use, time-limited (7-day) token links.

**Create Invite**
- Admin generates a 24-character random token
- Stores in `invite_links` with `expires_at`
- Returns `invite_url` = `${FRONTEND_URL}/invite/${token}`

**Preview Invite (Public)**
- No auth required
- Returns workspace name, inviter display name, and up to 3 active containers with contribution totals
- Validates: not expired, not already used

**Accept Invite**
- Requires authenticated user
- Validates: not expired, not used, user not already a member
- Creates `workspace_members` row with `role: 'member'`, `invite_status: 'accepted'`
- Marks invite as used with `used_at` + `used_by_user_id`
- Notifies all workspace admins

**List / Revoke Invites**
- Admin can view all issued invites and hard-delete (revoke) any by ID

**Legacy Route Compatibility**
- `/v1/invites/:token/preview` and `/v1/invites/:token/accept` maintained alongside `/v1/public/invites/:token` for backwards compatibility

---

### 3.6 Containers

Containers are the core entity — they represent either a **one-time event** or a **recurring contribution pool**.

**Container Types**
- `event` — A finite collection effort (e.g. wedding fund, funeral contributions, group birthday gift)
- `recurring` — An ongoing pool with automatic cycle generation (e.g. weekly savings circle)

**Container Features (Toggleable)**
- `enable_money` — Tracks financial contributions via the ledger system
- `enable_tasks` — Enables task assignment and tracking
- Both can be independently enabled/disabled per container

**Container States**
- `active` → `completed` → `archived`
- Soft-deleted containers can be restored by admins

**CRUD**
- Create: admin-only; triggers `cycle-generation-queue` job for recurring containers
- Read: includes current user participation, current cycle (recurring), participant count
- Update: admin-only; guards against disabling money if ledger entries exist
- Delete: soft-delete; blocked if confirmed ledger entries exist
- Restore: unsets `deleted_at` (admin-only)

**Complete Container**
- Sets status to `completed`, stores `outcome_details` and `outcome_files`
- Auto-creates a milestone entry `"<name> completed"`
- Notifies all participants

**Convert to Recurring**
- Event-only operation; converts to a recurring pool
- Atomic `convert_event_to_recurring_atomic` RPC ensures container creation + participant migration happen in one transaction
- Triggers cycle generation queue job

**Archive Container**
- Sets status to `archived`; only active or completed containers can be archived

**Public Sharing**
- `POST /generate-public-link` — generates cryptographic public token; stores in `containers.public_token`
- `GET /v1/public/containers/:publicToken` — unauthenticated read-only view showing progress, total collected, and optionally contributor names (controlled by `public_show_names` flag)

**Container Summary**
- `GET /:containerId/summary` — rich aggregate: total expected, confirmed, pending, progress %, per-participant status (paid/partial/overdue/pending/no_target). Admin sees financial details; members see own + others' status only.

**Cycles**
- `GET /:containerId/cycles` — paginated list of all cycles with status filter (admin-only)

**File Uploads**
- Outcome files: signed upload URL → `outcome/<containerId>/`
- Cover photos: signed upload URL → `covers/<containerId>/`

---

### 3.7 Participants

Participants link workspace members to containers with per-member settings.

**Add Participants**
- Batch add with individual `money_enabled`, `tasks_enabled`, and `role` per participant
- Optionally creates a `contributor_target` if `target.amount` is provided
- Validates all members exist in workspace; reports skip counts

**Add from Group**
- Bulk-adds all non-deleted members of a named group to a container

**Update Participant**
- Toggles `money_enabled`, `tasks_enabled`, `role`, `notes`, `exclude_from_public`

**Remove Participant**
- Hard-delete from `container_participants`
- Blocked if participant has confirmed ledger entries

**Contributor Target Management**
- `POST /:participantId/set-target` — creates a new target, supersedes the previous current target (updates `is_current: false`, `superseded_at`, `superseded_by`)
- `GET /:participantId/target-history` — full history of all targets set for a participant
- `GET /:participantId/cycle-targets` — per-cycle target and payment status for recurring containers

**Cycle Overrides**
- `POST /cycles/:cycleId/override` — inserts a `pool_cycle_overrides` record for one of:
  - `skip_member` — skip a specific member for this cycle
  - `adjust_target` — change target amount for a cycle
  - `pause_pool` — sets cycle status to `skipped`

---

### 3.8 Ledger (Financial Contributions)

The ledger is the core financial engine. Every contribution attempt is recorded as a `ledger_entry`.

**Entry Lifecycle (Status Flow)**
```
pending → proof_uploaded → confirmed
pending → disputed → (resolved → confirmed or deleted)
pending → deleted (pre-confirmation only)
```

**Create Entry**
- Member creates entry for themselves; admin creates for any participant
- Proxy members: only admins can record entries on their behalf
- Idempotency key: `X-Idempotency-Key` header deduplicates on retry
- Duplicate detection: 10-minute window check (same contributor + amount) — blocks unless `?force=true`
- Admin entries are auto-confirmed; member entries start as `pending`
- Proxy action logged in `proxy_actions` table when admin acts for proxy member
- Notifies admins when a member submits (`contribution_submitted`)

**Read**
- `GET /ledger` — paginated list; admin sees all, member sees own; filterable by contributor, status, date
- `GET /ledger/:entryId` — single entry with member access control
- `GET /ledger/summary` — aggregate counts and totals by status (admin sees all, member sees own)

**Update**
- Only `pending` entries can be edited
- Member can edit own pending entries (amount, currency, method, note)
- Admin can also change `contributor_id`

**Delete**
- Only `pending` or `proof_uploaded` entries can be deleted
- Members can delete own; admins can delete any
- Confirmed entries are immutable — use corrections instead

**Proof Upload**
- Two-step: `POST /upload-proof` → get signed URL → upload directly to Supabase Storage → `POST /confirm-proof` to register in `proofs` JSONB array
- Confirmation changes status to `proof_uploaded` if currently `pending`
- `GET /proof-url` — generates signed download URL (15-minute TTL)
- `DELETE /proof/:proofIndex` — removes a specific proof by array index; members cannot remove proofs from confirmed entries

**Admin Confirmation**
- `POST /:entryId/confirm` — sets `status: 'confirmed'`, records `confirmed_by` + `confirmed_at`
- Notifies the contributor

**Corrections**
- `POST /:entryId/add-correction` — creates a new `correction`-type ledger entry auto-confirmed, linked to source entry via `corrects_entry_id`
- Used for post-confirmation adjustments without deleting confirmed entries

**Disputes**
- See Section 3.9

**Export**
- `GET /ledger/export` — CSV download of all entries for the workspace (filterable by container, date range); admin-only

---

### 3.9 Disputes

A formal dispute lifecycle on ledger entries.

**Raise Dispute**
- Any member can dispute their own entries; admins can dispute any
- Only `confirmed` or `pending` entries can be disputed
- Atomic `raise_dispute_atomic` RPC: inserts `disputes` row + sets `ledger_entries.status = 'disputed'` in one transaction
- Notifies all workspace admins

**Add Notes**
- Both the raiser and admins can add notes to an open dispute
- Notes stored as JSONB array with `author_id`, `note`, `added_at`

**Resolve Dispute**
- Admin-only; only `open` disputes can be resolved
- Atomic `resolve_dispute_atomic` RPC: marks dispute as resolved + updates linked ledger entry status
- Notifies the dispute raiser

**List / Get Disputes**
- `GET /disputes` — admin-only paginated list with status filter and joined entry data
- `GET /disputes/:disputeId` — accessible by raiser or admin; returns dispute + full entry detail

---

### 3.10 Tasks

Task management tied to containers.

**Task States:** `todo` → `in_progress` → `completed` → (admin confirms)

**Create / Bulk Create**
- Admin creates tasks and assigns to container participants
- Bulk create accepts array of tasks with per-task error handling (partial success)
- Assignment triggers `task_assigned` notification

**Read**
- `GET /tasks` — admin sees all tasks in container; member sees only their assigned tasks
- `GET /tasks/:taskId` — same visibility scoping

**Update**
- Admin can update all fields (title, description, assigned_to, due_date, status, sort_order, completion_note)
- Member can only update `status` (limited to `in_progress` or `completed`) and `completion_note`
- Completing a task notifies all admins; reassigning to new member notifies the new assignee

**Reassign**
- Admin-only dedicated endpoint
- Cannot reassign tasks that are already `in_progress` or `completed` (must override status first)

**Override Status**
- Admin-only hard override to any status; records completion metadata

**Admin Confirm Task**
- Two-phase: member completes → admin confirms
- Sets `admin_confirmed_at`, `admin_confirmed_by`, `admin_note`
- Notifies the assignee

**Proof System**
- Same two-step upload flow as ledger proofs
- `POST /upload-proof` → signed URL → `POST /confirm-proof` → appends to `proofs` JSONB array
- `DELETE /proof/:proofIndex` — removes specific proof by index

**Export**
- Admin: full CSV export via `exportTasksCSV` service
- Member: CSV of their own tasks only

**Delete**
- Soft-delete (`deleted_at` timestamp)

---

### 3.11 Milestones & Timeline

**Milestones**
- Admin-created records with title, date, description, type, photos
- Auto-created when a container is completed (`"<name> completed"`)
- Full CRUD: create, get, update, soft-delete
- Photo upload via two-step signed URL → confirm flow

**Timeline**
- `GET /timeline` — merges completed containers and milestones into a unified chronological feed
- Cursor-based pagination via `before` parameter (ISO date)
- Items typed as `container_completed` or `milestone`

---

### 3.12 Notifications

**Notification Types (Inferred from code)**
- `contribution_submitted` — admin notified when member submits
- `contribution_confirmed` — member notified when admin confirms
- `contribution_disputed` — admins notified when a dispute is raised
- `dispute_resolved` — raiser notified when dispute resolved
- `container_completed` — all participants notified
- `task_assigned` — assignee notified
- `task_completed` — admins notified
- `task_confirmed` — assignee notified
- `invite_accepted` — admins notified
- `admin_announcement` — targeted broadcast to all or role-filtered members

**Notification Routing**
- Notifications are scoped to `workspace_members.id` (not `users.id`)
- `resolveMember` middleware in notification routes resolves member from JWT user + optional `workspace_id` query param
- Supports querying across all memberships or within a specific workspace

**Endpoints**
- `GET /v1/notifications/count` — lightweight unread badge count (polling endpoint)
- `GET /v1/notifications` — paginated list; filterable by `is_read`, `workspace_id`
- `PATCH /v1/notifications/read-all` — mark all (or workspace-scoped) read
- `PATCH /v1/notifications/:id/read` — mark one read

**Outbox / Reliability**
- Notification outbox queue runs every 5 minutes to retry stuck external channel (push/email) deliveries

---

### 3.13 Recurring Pool / Cycle System

**Cycle Generation**
- Created asynchronously via `cycle-generation-queue` when a recurring container is created or converted
- Generates 3 months of cycles ahead; daily maintenance job extends the window

**Cycle Lifecycle**
- `cycle-lifecycle-queue` runs daily at 00:01 UTC: opens upcoming cycles, closes past cycles

**Cycle Targets**
- Each participant can have per-cycle targets (separate from their base target)
- `GET /participants/:participantId/cycle-targets` — shows per-cycle: target amount, confirmed paid, status (paid/partial/pending/overdue/skipped)

**Cycle Overrides**
- `skip_member` — marks a member as skipped for a cycle
- `adjust_target` — changes a member's target for a specific cycle
- `pause_pool` — sets the entire cycle to `skipped` status

**Carry-Forward Logic**
- `carry_forward_unpaid` flag on containers signals that unpaid balances from closed cycles should roll over (worker-implemented behavior)

---

## 4. Endpoint Analysis

### Auth Routes `/v1/auth`

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| POST | `/signup` | None | Create account | Creates Supabase user + `users` row; sends verification email |
| POST | `/login` | None | Email login | Sets `refresh_token` cookie; returns access_token + memberships |
| POST | `/refresh` | Cookie | Refresh token | Rotates refresh_token cookie |
| POST | `/forgot-password` | None | Request reset | Sends reset email (always 200) |
| GET | `/google/url` | None | OAuth URL | Returns Supabase OAuth redirect URL |
| POST | `/google/callback` | None | OAuth exchange | Upserts user; sets cookie; returns tokens |
| POST | `/verify-email` | None | OTP verify | Validates token_hash; returns session |
| POST | `/logout` | JWT | Logout | Clears cookie; invalidates Supabase session |
| POST | `/logout-all-devices` | JWT | Global logout | Clears cookie; revokes ALL sessions |
| POST | `/reset-password` | JWT (recovery) | Reset password | Updates password via admin SDK |
| POST | `/register` | JWT | Upsert profile | Creates/updates `users` row post-auth |
| GET | `/me` | JWT | Get user | Returns user + memberships (uses req.dbUser) |
| PATCH | `/profile` | JWT | Update profile | Updates `users` row |
| POST | `/avatar/upload-url` | JWT | Avatar upload | Returns signed Supabase Storage URL |
| PATCH | `/contacts` | JWT | Bulk replace contacts | Delete-then-batch-upsert |
| GET | `/contacts` | JWT | List contacts | Returns all `user_contacts` |
| POST | `/contacts` | JWT | Upsert contact | Atomic RPC for primary contact |
| DELETE | `/contacts/:id` | JWT | Delete contact | 404 if not found |
| POST | `/push-token` | JWT | Register FCM | Updates `users.push_token` |
| PATCH | `/notification-preferences` | JWT | Toggle push/email | Updates `users` prefs |
| POST | `/data-export` | JWT | GDPR export | Enqueues `data-export-queue` job |

---

### Public Routes `/v1/public`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/invites/:token` | None | Preview invite — workspace name, inviter, container preview |
| POST | `/invites/:token/accept` | JWT | Accept invite — creates workspace_members row |
| GET | `/containers/:publicToken` | None | Read-only container progress view |

---

### Workspace Routes `/v1/workspaces`

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/` | No | List caller's workspaces |
| POST | `/` | No | Create workspace (atomic RPC) |
| GET | `/:id` | No | Get workspace |
| PATCH | `/:id` | Yes | Update workspace |
| DELETE | `/:id` | Yes | Soft-delete workspace |
| GET | `/:id/dashboard` | No | Dashboard aggregate |
| GET | `/:id/settings` | Yes | Key-value settings |
| PATCH | `/:id/settings` | Yes | Update settings |
| GET | `/:id/search` | No | Cross-entity search |
| POST | `/:id/announce` | Yes | Broadcast notification |
| GET | `/:id/audit-log` | Yes | Paginated audit log |
| GET | `/:id/audit-log/export` | Yes | CSV export up to 10k rows |
| GET | `/:id/overdue-summary` | Yes | Per-member overdue totals |
| POST | `/:id/avatar-upload-url` | Yes | Signed workspace avatar upload URL |

---

### Member Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/members` | No | List members (role/proxy/search filterable) |
| POST | `/members` | Yes | Create proxy member |
| GET | `/members/engagement` | Yes | Per-member engagement report |
| GET | `/members/:id` | No | Get member |
| PATCH | `/members/:id` | Self/Admin | Update member fields |
| DELETE | `/members/:id` | Yes | Soft or hard delete |
| GET | `/members/:id/profile-history` | Yes | Audit trail for profile changes |
| GET | `/members/:id/contribution-summary` | No | Contribution totals by container |

---

### Container Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/containers` | No | List containers (type/status filterable) |
| POST | `/containers` | Yes | Create container; triggers cycle gen if recurring |
| GET | `/containers/:id` | No | Get container + cycle + user participation |
| PATCH | `/containers/:id` | Yes | Update container |
| DELETE | `/containers/:id` | Yes | Soft-delete (blocked if confirmed entries) |
| POST | `/containers/:id/restore` | Yes | Undelete soft-deleted container |
| POST | `/containers/:id/complete` | Yes | Mark completed; auto-creates milestone; notifies participants |
| POST | `/containers/:id/convert-to-recurring` | Yes | Atomic convert event → recurring pool |
| POST | `/containers/:id/archive` | Yes | Archive active/completed container |
| POST | `/containers/:id/generate-public-link` | Yes | Create public share token |
| GET | `/containers/:id/summary` | No | Aggregate contribution summary per participant |
| GET | `/containers/:id/cycles` | Yes | Paginated cycle list |
| POST | `/containers/:id/outcome-files/upload-url` | Yes | Outcome file signed URL |
| POST | `/containers/:id/cover-photos/upload-url` | Yes | Cover photo signed URL |

---

### Participant Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/containers/:id/participants` | Yes | List participants with targets |
| POST | `/containers/:id/participants` | Yes | Add participants (batch) with optional targets |
| POST | `/containers/:id/participants/from-group` | Yes | Bulk add from a group |
| PATCH | `/containers/:id/participants/:pid` | Yes | Update money/tasks/role/notes |
| DELETE | `/containers/:id/participants/:pid` | Yes | Remove (blocked if confirmed entries) |
| POST | `/containers/:id/participants/:pid/set-target` | Yes | Set new target; supersedes previous |
| GET | `/containers/:id/participants/:pid/target-history` | Yes | Full target history |
| GET | `/containers/:id/participants/:pid/cycle-targets` | Yes | Per-cycle status |
| POST | `/containers/:id/cycles/:cid/override` | Yes | Cycle override (skip/adjust/pause) |

---

### Ledger Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/containers/:id/ledger` | No* | List entries (member sees own; admin sees all) |
| POST | `/containers/:id/ledger` | No | Create entry (idempotency + dup detection) |
| GET | `/containers/:id/ledger/summary` | No* | Aggregate totals by status |
| GET | `/containers/:id/ledger/:eid` | No* | Single entry |
| PATCH | `/containers/:id/ledger/:eid` | No* | Update pending entry |
| DELETE | `/containers/:id/ledger/:eid` | No* | Delete pending/proof_uploaded entry |
| DELETE | `/containers/:id/ledger/:eid/proof/:idx` | No* | Remove proof by index |
| POST | `/containers/:id/ledger/:eid/upload-proof` | No* | Get proof upload URL |
| POST | `/containers/:id/ledger/:eid/confirm-proof` | No* | Register uploaded proof |
| POST | `/containers/:id/ledger/:eid/confirm` | Yes | Admin confirm entry |
| POST | `/containers/:id/ledger/:eid/dispute` | No* | Raise dispute (atomic) |
| POST | `/containers/:id/ledger/:eid/add-correction` | Yes | Create correction entry |
| GET | `/containers/:id/ledger/:eid/proof-url` | No* | Signed proof download URL |
| GET | `/ledger/export` | Yes | Workspace-wide CSV export |

*Member scoped — non-admins see only their own data

---

### Dispute Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/disputes` | Yes | Paginated dispute list |
| GET | `/disputes/:did` | Self/Admin | Get dispute + entry detail |
| POST | `/disputes/:did/note` | Self/Admin | Add note to dispute |
| POST | `/disputes/:did/resolve` | Yes | Resolve dispute (atomic) |

---

### Task Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/containers/:id/tasks` | No* | List tasks |
| POST | `/containers/:id/tasks` | Yes | Create task; notify assignee |
| POST | `/containers/:id/tasks/bulk` | Yes | Bulk create with partial error handling |
| GET | `/containers/:id/tasks/export` | No | CSV export (admin = all; member = own) |
| GET | `/containers/:id/tasks/:tid` | No* | Get task |
| PATCH | `/containers/:id/tasks/:tid` | No* | Update task (member: status/note only) |
| DELETE | `/containers/:id/tasks/:tid` | Yes | Soft-delete task |
| PATCH | `/containers/:id/tasks/:tid/reassign` | Yes | Reassign task |
| PATCH | `/containers/:id/tasks/:tid/status` | Yes | Hard status override |
| POST | `/containers/:id/tasks/:tid/confirm` | Yes | Admin confirm completed task |
| POST | `/containers/:id/tasks/:tid/upload-proof` | No* | Get proof upload URL |
| POST | `/containers/:id/tasks/:tid/confirm-proof` | No* | Register uploaded proof |
| DELETE | `/containers/:id/tasks/:tid/proof/:idx` | No* | Remove task proof by index |

---

### Milestone & Timeline Routes

| Method | Path | Admin | Purpose |
|---|---|---|---|
| GET | `/timeline` | No | Merged timeline (milestones + completed containers) |
| POST | `/milestones` | Yes | Create milestone |
| GET | `/milestones/:mid` | No | Get milestone |
| PATCH | `/milestones/:mid` | Yes | Update milestone |
| DELETE | `/milestones/:mid` | Yes | Soft-delete milestone |
| POST | `/milestones/:mid/photos/upload-url` | Yes | Milestone photo upload URL |
| POST | `/milestones/:mid/photos/confirm` | Yes | Register milestone photo |

---

### Notification Routes `/v1/notifications`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/count` | JWT | Unread badge count |
| GET | `/` | JWT | Paginated notifications (is_read, workspace_id filterable) |
| PATCH | `/read-all` | JWT | Mark all read (optionally workspace-scoped) |
| PATCH | `/:id/read` | JWT | Mark one read |

---

## 5. User Flows & Workflows

### 5.1 Onboarding Flow

```
1. User visits /invite/:token
   → GET /v1/public/invites/:token
   → UI shows workspace name, inviter, active containers preview

2. User signs up (if not yet registered)
   → POST /v1/auth/signup (creates Supabase user + users row)
   → Email verification if required
   → POST /v1/auth/verify-email (exchanges OTP for session)

3. User accepts invite
   → POST /v1/public/invites/:token/accept (requires JWT)
   → Creates workspace_members row
   → Admins notified of new member

4. User completes profile
   → POST /v1/auth/register (upsert profile)
   → PATCH /v1/auth/profile (optional additional fields)

5. User registers push token (mobile)
   → POST /v1/auth/push-token
```

### 5.2 Contribution Submission Flow (Member)

```
1. Member selects a container
   → GET /v1/workspaces/:wid/containers/:cid
   → GET /v1/workspaces/:wid/containers/:cid/ledger/summary

2. Member creates ledger entry
   → POST /v1/workspaces/:wid/containers/:cid/ledger
   → Status: pending
   → Admins notified via notification-queue

3. Member uploads proof
   → POST /v1/.../ledger/:eid/upload-proof → gets signed URL
   → Client uploads file directly to Supabase Storage
   → POST /v1/.../ledger/:eid/confirm-proof → registers proof
   → Status transitions to: proof_uploaded
   → Admins notified again (contribution_submitted)

4. Admin confirms entry
   → POST /v1/.../ledger/:eid/confirm
   → Status: confirmed
   → Member notified (contribution_confirmed)
```

### 5.3 Dispute Resolution Flow

```
1. Member or admin raises dispute
   → POST /v1/.../ledger/:eid/dispute
   → Atomic RPC: INSERT disputes + UPDATE ledger status = 'disputed'
   → Admins notified

2. Parties add notes
   → POST /v1/.../disputes/:did/note (both raiser and admin)

3. Admin resolves
   → POST /v1/.../disputes/:did/resolve
   → Atomic RPC: UPDATE disputes.status + UPDATE ledger status
   → Raiser notified (dispute_resolved)
```

### 5.4 Recurring Pool Cycle Flow (Automated)

```
1. Admin creates recurring container
   → POST /v1/workspaces/:wid/containers (container_type: 'recurring')
   → cycle-generation-queue receives job: generate 3 months of cycles

2. Daily at 00:01 UTC:
   → cycle-lifecycle-queue runs
   → Opens cycles whose start date has arrived
   → Closes cycles whose end date has passed
   → Carry-forward logic processes unpaid balances (if enabled)

3. Daily at 03:00 UTC:
   → cycle-generation-queue maintenance job runs
   → Extends forward planning to maintain 3-month horizon

4. Member/admin submits contribution for a specific cycle
   → POST /v1/.../ledger with cycle_id field
   
5. Admin can override specific cycles
   → POST /v1/.../cycles/:cid/override (skip_member / adjust_target / pause_pool)
```

### 5.5 Task Lifecycle Flow

```
1. Admin creates task (assigned to a participant)
   → POST /v1/.../tasks
   → Status: todo
   → Assignee notified (task_assigned)

2. Member updates status
   → PATCH /v1/.../tasks/:tid
   → Member can set: in_progress or completed
   → When completed: admins notified (task_completed)

3. Member optionally uploads proof
   → POST /upload-proof → POST /confirm-proof

4. Admin confirms
   → POST /v1/.../tasks/:tid/confirm
   → Sets admin_confirmed_at, admin_confirmed_by
   → Assignee notified (task_confirmed)
```

### 5.6 Event Completion + Timeline Flow

```
1. Admin completes container
   → POST /v1/.../containers/:cid/complete
   → Status: completed
   → outcome_details and outcome_files stored
   → Auto-creates milestone: "<container name> completed"
   → All participants notified (container_completed)

2. Admin optionally creates additional milestones
   → POST /v1/.../milestones

3. Anyone views the timeline
   → GET /v1/.../timeline
   → Merged feed of completed containers + milestones, sorted by date
```

### 5.7 GDPR Data Export Flow

```
1. User requests export
   → POST /v1/auth/data-export
   → Server fetches all user's workspace IDs
   → Enqueues job to data-export-queue: { userId, userEmail, workspaceIds }

2. Worker processes async
   → Exports ledger data across all workspaces
   → Sends result as email attachment to userEmail
   → Retries up to 2x with exponential backoff
```

---

## 6. Data Models & System Relationships

### Core Entity Diagram

```
users (1) ─────────────────────── (N) workspace_members
                                          │
workspaces (1) ──────────────────── (N) workspace_members
workspaces (1) ──────────────────── (N) containers
workspaces (1) ──────────────────── (N) groups
workspaces (1) ──────────────────── (N) invite_links
workspaces (1) ──────────────────── (N) audit_log
workspaces (1) ──────────────────── (N) milestones
workspaces (1) ──────────────────── (N) notifications
workspaces (1) ──────────────────── (N) workspace_settings (key-value)

workspace_members (N) ──────── (N) groups  [via group_members]
containers (1) ──────────────────── (N) container_participants
containers (1) ──────────────────── (N) ledger_entries
containers (1) ──────────────────── (N) container_tasks
containers (1) ──────────────────── (N) container_cycles [recurring only]

container_participants (1) ──── (N) contributor_targets
container_participants (1) ──── (N) ledger_entries [via contributor_id]

ledger_entries (1) ──────────── (0-1) disputes
ledger_entries (1) ──────────── (N) ledger_entries [via corrects_entry_id]

contributor_targets ─────────── linked list via superseded_by → superseded_by
container_cycles (1) ─────────── (N) pool_cycle_overrides
```

### Key Tables Inferred

| Table | Purpose | Notable Fields |
|---|---|---|
| `users` | Supabase auth + profile | `id`, `email`, `full_name`, `avatar_url`, `push_token`, `push_token_platform`, `push_enabled`, `email_digest_enabled`, `auth_provider`, `deleted_at` |
| `workspaces` | Tenant root | `id`, `name`, `base_currency`, `avatar_url`, `visibility`, `deleted_at` |
| `workspace_members` | User-to-workspace binding | `id`, `workspace_id`, `user_id`, `role`, `display_name`, `is_proxy`, `proxy_managed_by`, `is_active`, `relationship_to_head`, `relationship_category`, `date_of_birth`, `admin_notes`, `last_active_at`, `contribution_streak_months`, `deleted_at` |
| `workspace_settings` | Key-value config per workspace | `workspace_id`, `setting_key`, `setting_value`, `updated_by`, `updated_at` |
| `groups` | Member subsets for bulk ops | `id`, `workspace_id`, `name`, `description`, `created_by` |
| `group_members` | Group membership | `group_id`, `workspace_member_id`, `added_by`, `added_at` |
| `invite_links` | Single-use join tokens | `id`, `workspace_id`, `token`, `created_by`, `expires_at`, `used_at`, `used_by_user_id` |
| `containers` | Event or recurring pools | `id`, `workspace_id`, `name`, `container_type`, `status`, `enable_money`, `enable_tasks`, `event_date`, `recurrence_cadence`, `recurrence_days`, `recurrence_start`, `recurrence_end`, `carry_forward_unpaid`, `budget_target`, `budget_currency`, `public_token`, `public_show_names`, `outcome_details`, `outcome_files` (JSONB), `cover_photos` (JSONB), `converted_from_id`, `deleted_at` |
| `container_participants` | Container membership | `id`, `container_id`, `workspace_member_id`, `money_enabled`, `tasks_enabled`, `role`, `notes`, `exclude_from_public`, `added_by` |
| `contributor_targets` | Contribution goals | `id`, `container_participant_id`, `container_id`, `workspace_member_id`, `target_amount`, `target_currency`, `due_date`, `is_current`, `cycle_id`, `set_by`, `superseded_at`, `superseded_by` |
| `container_cycles` | Recurring cycle records | `id`, `container_id`, `cycle_number`, `cycle_start`, `cycle_end`, `status`, `total_expected`, `total_collected` |
| `pool_cycle_overrides` | Per-cycle exceptions | `container_id`, `cycle_start`, `override_type`, `member_id`, `new_target`, `reason`, `created_by` |
| `ledger_entries` | Financial contributions | `id`, `workspace_id`, `container_id`, `cycle_id`, `entry_type`, `contributor_id`, `original_amount`, `original_currency`, `base_amount`, `payment_method`, `is_crypto`, `status`, `proofs` (JSONB array), `note`, `recorded_by`, `confirmed_at`, `confirmed_by`, `corrects_entry_id`, `idempotency_key` |
| `disputes` | Contribution disputes | `id`, `workspace_id`, `ledger_entry_id`, `raised_by`, `status`, `reason`, `notes` (JSONB array), `raised_at`, `resolved_by`, `resolution_note` |
| `container_tasks` | Task records | `id`, `container_id`, `title`, `description`, `assigned_to`, `due_date`, `status`, `sort_order`, `proofs` (JSONB), `completion_note`, `completed_at`, `completed_by`, `admin_confirmed_at`, `admin_confirmed_by`, `admin_note`, `deleted_at` |
| `milestones` | Timeline entries | `id`, `workspace_id`, `title`, `description`, `milestone_date`, `milestone_type`, `photos` (JSONB), `created_by`, `deleted_at` |
| `notifications` | In-app notifications | `id`, `workspace_id`, `recipient_id` (workspace_member id), `type`, `reference_type`, `reference_id`, `variables` (JSONB), `is_read`, `read_at`, `created_at` |
| `audit_log` | Admin action log | `id`, `workspace_id`, `actor_member_id`, `action`, `target_type`, `target_id`, `metadata` (JSONB), `created_at` |
| `member_profile_audit` | Profile change history | `workspace_member_id`, `changed_by`, `field_name`, `old_value`, `new_value`, `change_source`, `changed_at` |
| `proxy_actions` | Actions taken on behalf of proxy members | `workspace_id`, `proxy_member_id`, `managed_by_id`, `action_type`, `target_id`, `action_details` (JSONB) |
| `user_contacts` | External contact methods | `id`, `user_id`, `type`, `value`, `label`, `country_code`, `is_primary` |

### Ownership & Lifecycle Rules

- **Workspace members** cannot be hard-deleted if they have confirmed ledger entries — prevents orphaned financial history
- **Containers** cannot be deleted if they have confirmed entries — same financial integrity guarantee
- **Participants** cannot be removed if they have confirmed entries
- **Contributor targets** form a linked list: setting a new target supersedes the previous (which becomes `is_current: false`)
- **Ledger entries** once `confirmed` are effectively immutable — adjustments must go through the corrections system
- **Invites** are single-use and have a 7-day TTL enforced at runtime
- Soft-deletes are used throughout (`deleted_at`) with queries filtering `.is('deleted_at', null)`

---

## 7. WebSocket / Real-Time Systems

**No WebSocket system is present in the analyzed codebase.**

The application uses a polling model for real-time updates:
- Notification badge count: `GET /v1/notifications/count` — designed as a lightweight poll endpoint
- No socket.io, ws, or any WebSocket library is imported or referenced
- The BullMQ outbox queue (every 5 minutes) handles deferred push/email delivery but not real-time in-browser updates

**Implication for frontend:** The frontend must poll for notifications. The `GET /notifications/count` endpoint is clearly designed for this use case — it returns only an integer, minimizing payload.

---

## 8. AI Systems

**No AI/ML system is present in the analyzed codebase.**

The product is entirely rule-based. No integrations with OpenAI, Anthropic, Hugging Face, or any ML inference service are referenced.

Opportunities for AI augmentation are noted in Section 12.

---

## 9. Product & UX Intelligence

### Why Workflows Are Designed This Way

**Two-step file upload (URL → confirm)** is the correct pattern for large file uploads through an API backend. Clients get a signed URL and upload directly to Supabase Storage, avoiding routing binary data through the Node.js server. The explicit `confirm-proof` step is deliberate — it ensures the backend registers only successfully uploaded files, not just "upload URL issued."

**Admin-auto-confirm on ledger entry creation** reflects real-world group treasurer behavior: when the treasurer (admin) manually logs a payment they received in person, there's no need for a proof workflow — they are the source of truth. The dual path (admin = instant confirmed; member = pending until verified) mirrors the trust hierarchy naturally.

**Proxy member model** is a sophisticated UX decision. In many community groups, some members (elderly parents, children) are not digital users. The proxy model allows their contributions to be tracked without requiring them to sign up. This is a feature most competitors completely miss.

**Invite preview before acceptance** reduces abandonment — showing the workspace name, inviter, and what the group is working on creates social proof before requiring registration.

**Optimistic locking on member update** (`version` matching `updated_at`) prevents lost updates in concurrent admin UIs.

### Friction Points

1. **No WebSocket push** — Users won't see new notifications without polling; on mobile this may drain battery if poll interval is short
2. **No email enumeration prevention on login** — The forgot-password endpoint prevents this, but login returns `"Invalid email or password"` which a sophisticated attacker could use (though this is standard practice)
3. **Bulk group member add uses a sequential for-loop** — N database round-trips when adding members to a group; not a problem at small scale but degrades at 50+ members
4. **Member engagement calculation is N+1** — `getMemberEngagement` runs 2 parallel queries per member in `Promise.all`, which means for 100 members = 200 DB queries simultaneously

### Retention Mechanics

- **Milestone timeline** creates a visual history of the group's achievements — high emotional value, increases group cohesion
- **Overdue summary** creates admin urgency to follow up with delinquent members
- **Recurring pool cycles** create a perpetual engagement loop — the product is always "in use" as long as the pool is active
- **Public share links** extend reach beyond app users (shared on WhatsApp, etc.)
- **Notifications for every meaningful event** keep all participants informed and engaged

---

## 10. Risks & Technical Debt

### Critical Security Issues

**1. Notification member resolution — `resolveMember` middleware**
If a user belongs to multiple workspaces and doesn't provide `workspace_id`, the middleware picks the most recent membership. This means `GET /notifications` without a `workspace_id` filter returns notifications scoped to whichever workspace the user joined most recently — **not all notifications across all workspaces**. This could confuse users with multiple memberships.

**2. Proxy action logging is inconsistent**
`proxy_actions` is only logged when `createEntry` is called for a proxy member. Other admin actions on behalf of proxies (e.g., setting targets, completing tasks) do not log to `proxy_actions`. This creates an incomplete audit trail for proxy accountability.

**3. `deleteContainer` has a permission gap**
`deleteContainer` calls `supabaseAdmin.from('containers').update({ deleted_at })` but does NOT check whether the container was already soft-deleted (no `.is('deleted_at', null)` guard unlike `getContainer` and other endpoints). A double-delete call on an already-deleted container would succeed silently.

**4. `deleteMember` hard-delete path race condition**
The check (`count > 0`) and hard-delete are not atomic. A concurrent ledger entry confirmation between the check and the delete could result in a member being hard-deleted with an orphaned confirmed ledger entry.

### Scalability Risks

**5. `getMemberEngagement` is O(N×2) database queries**
For every member, 2 parallel queries are issued. At 200 members = 400 DB round-trips in a single request. This endpoint will time out for large workspaces. Fix: a single aggregated query using GROUP BY.

**6. `addGroupMembers` / `addParticipants` use sequential loops**
`addGroupMembers` loops over each member ID with individual upsert calls. For groups of 50+ members this creates significant latency. Fix: batch insert all valid members in one operation.

**7. Container `listContainers` joins ledger_entries**
The list query joins all `ledger_entries` per container to compute `total_confirmed_base`. For containers with thousands of entries, this will be slow. Fix: denormalized `total_confirmed_base` column maintained by triggers or worker.

**8. Dashboard is 7 parallel DB queries**
This is actually reasonable design, but the `getDashboard` query for `contributor_targets` joins deeply through multiple tables without explicit workspace scoping on some joins — the filter `.eq('container.workspace_id', workspaceId)` is done in JavaScript after fetching, not in the query.

### Architectural Concerns

**9. Notifications use `workspace_members.id` as `recipient_id`**
This is intentionally designed for workspace scoping, but it means a user in 3 workspaces has 3 different recipient IDs. The `resolveMember` middleware resolves one at a time. The notification system doesn't support "send to all memberships of this user" in a single call — this must be iterated by callers.

**10. No WebSocket — polling gap**
Users on mobile who are waiting for contribution confirmation will experience notification latency equal to whatever the frontend poll interval is. This is a UX issue more than a technical risk.

**11. JSONB arrays for proofs and photos are unbounded**
`proofs` and `photos` are JSONB arrays with no enforced size limit. A malicious or buggy client could append unlimited files, growing these columns unboundedly. Fix: server-side enforcement of maximum proof count.

**12. Invite links are never automatically cleaned up without the queue**
If the `invite-cleanup-queue` worker is not running, expired invite links accumulate indefinitely. This is low risk but is a maintenance hygiene issue.

**13. `resolve_dispute_atomic` RPC — final ledger status not specified**
The RPC `resolve_dispute_atomic` resolves the dispute and updates ledger entry status, but the code does not explicitly set what the ledger entry status becomes after resolution. The resolution could confirm or reject the entry — the exact behavior is in the DB-side RPC (not in the analyzed files).

### Code Quality Issues

**14. `addGroupMembers` + `createGroup` initial member add uses N sequential inserts**
Unlike `addParticipants` which was recently updated, group member addition is still sequential.

**15. Task `bulkCreateTasks` sends notifications inside a sequential loop**
For a bulk of 20 tasks, this fires up to 20 sequential notification sends — each potentially doing a DB query + queue insert. Fix: batch notifications.

**16. Container `getPublicContainer` leaks proof data**
The `ledger_entries` query for the public view only fetches `base_amount` but does not scope entries to `contributor_id` correctly when computing per-contributor paid amounts — it re-uses the `ledger` variable from the total query, which is correct, but if `public_show_names` is false, the full ledger is still fetched and aggregated unnecessarily.

---

## 11. Startup & Portfolio Analysis

### Startup Potential: ⭐⭐⭐⭐ (4/5)

**Strengths**

1. **Deep domain modeling** — The data model reflects genuine domain expertise: proxy members, carry-forward logic, cycle overrides, target supersession chains, dispute resolution, correction entries. These are features only built by someone who deeply understands community finance.

2. **Correct use of atomic RPCs** — The team clearly identified and fixed the most common distributed systems pitfall (TOCTOU) for critical state transitions. `raise_dispute_atomic`, `resolve_dispute_atomic`, `convert_event_to_recurring_atomic`, `create_workspace_with_admin`, and `upsert_primary_contact` all use server-side transactions. This is production-grade thinking.

3. **Queue architecture is well-structured** — 9 named queues with a central registry, name validation, correct scheduler pattern (jobs registered directly into target queues, not a separate scheduler queue). The 5-minute outbox scan is a professional reliability pattern.

4. **Security is taken seriously** — Helmet, CORS with origin whitelist, separate rate limiters per concern, `httpOnly` cookies for refresh tokens, IP whitelist + basic auth on the Bull Board admin panel.

5. **Audit trail is comprehensive** — Every significant admin action is logged. Member profile changes have a dedicated audit table with field-level change tracking. This is critical for trust in a group finance product.

6. **Issue tracking in code comments** — The codebase shows an active engineering culture: specific "Issue N" tags reference a tracked fix for a concrete bug. This demonstrates code review discipline.

**Weaknesses**

1. **No real-time** — A contribution confirmation system without push (WebSocket) feels slow. Members refreshing manually to see if their payment was confirmed is a significant UX gap.

2. **Missing pagination in some list endpoints** — `listGroups`, `listInvites`, `getTimeline` have no pagination (or only cursor-based limit without total count). At scale these will be slow.

3. **No multi-currency conversion engine** — `base_amount` field is present suggesting multi-currency intent, but there's no exchange rate integration visible. Groups with members in different countries must handle this manually.

4. **No search on ledger** — There's no text search on ledger entries (by note, contributor, etc.). At large ledger volume this makes auditing difficult.

### Defensibility

High switching cost once a group migrates — all historical contributions, proofs, dispute records, and milestones are locked in. The timeline/milestone system creates emotional attachment. Network effects within each workspace are strong (the more members, the more valuable the audit trail).

### Technical Impressiveness

The combination of atomic PostgreSQL RPCs for multi-step operations + BullMQ for async reliability + comprehensive audit logging + idempotency key support on the ledger puts this well above typical CRUD Express apps. An interviewer or technical reviewer would recognize this as production-grade thinking.

### Monetization Possibilities

- **Freemium** — Free for up to N members / X containers; paid tiers for larger groups
- **Transaction fees** — When integrated with payment rails (M-Pesa, Stripe), charge a small fee per confirmed contribution
- **Premium features** — Automated reminders, WhatsApp integration, advanced analytics, multi-currency conversion
- **B2B** — License to cooperative credit societies, saccos, microfinance institutions, diaspora remittance groups

---

## 12. Future Evolution

### Immediate Technical Improvements (Low Effort, High Value)

1. **WebSocket / SSE for live notifications** — Replace notification polling with Server-Sent Events or Socket.IO rooms per workspace. Supabase Realtime could handle this via row-level subscriptions on the `notifications` table.

2. **Batch group member operations** — Replace sequential loops in `addGroupMembers` and `createGroup` initial members with batch inserts.

3. **Paginate `getTimeline` with cursor + count** — Expose `total` in timeline response for infinite scroll UX.

4. **Denormalize `total_confirmed_base` on containers** — Maintain a denormalized column via a DB trigger or worker; avoid the full ledger join on list queries.

5. **Fix `getMemberEngagement` N+1** — Single SQL query with GROUP BY aggregation.

### Near-Term Feature Expansion

6. **Payment rail integration** — Connect with Stripe (cards), M-Pesa (East Africa), Flutterwave (West Africa), or local bank transfers. Auto-confirm entries on webhook receipt.

7. **WhatsApp notifications** — Critical for the target demographic. Replace or augment push with WhatsApp Business API message templates.

8. **Automated reminders** — The `reminder-queue` cron exists but the worker is not in the analyzed files. Surface configuration to admins: "Send reminder X days before due_date."

9. **Multi-currency exchange rates** — Integrate an FX rate API (Open Exchange Rates, XE) to auto-populate `base_amount` from `original_amount` + `original_currency`.

10. **Invite link reuse** — Support optional `max_uses` on invite links (currently single-use only). Useful for sharing in WhatsApp groups.

### Architecture Evolution

11. **Read replicas** — Separate read-heavy endpoints (dashboard, ledger list, engagement) to a read replica connection.

12. **Event sourcing for ledger** — The ledger is nearly event-sourced already (corrections instead of updates, immutable confirmed entries). A full event-sourced ledger would enable any-point-in-time balance reconstruction.

13. **Realtime via Supabase Realtime** — Supabase's built-in realtime subscriptions on `notifications` table would give sub-second notification delivery with minimal backend changes.

14. **Dedicated analytics service** — Export audit_log + ledger_entries to a data warehouse (BigQuery, Redshift) for group-level analytics dashboards.

### AI Opportunities

15. **Contribution anomaly detection** — Flag unusual contribution patterns (sudden large amounts, duplicate-timing patterns) using simple ML or rule-based heuristics.

16. **Automated contribution categorization** — NLP on proof image text (OCR) to extract payment amount and date from uploaded receipts, pre-filling the ledger entry.

17. **Intelligent reminder scheduling** — Use payment history to predict likelihood of on-time payment and target reminders to likely-late contributors.

18. **AI-assisted dispute resolution** — When a dispute is raised, extract evidence from proof images and suggest a resolution to the admin.

---

*Document generated from complete analysis of 20 source files: `app.js`, `auth_routes.js`, `notification_routes.js`, `public_routes.js`, `invite_routes.js`, `workspace_routes.js`, `index.js` (queues), `scheduler.js`, and controllers: `dispute`, `group`, `invite`, `auth`, `container`, `member`, `milestone`, `ledger`, `participant`, `notification`, `task`, `workspace`.*
