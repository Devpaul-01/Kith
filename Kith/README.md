# 🚀 Kith

**The financial and task coordination backend for families, groups, and communities — built for real operational scale.**

---

## ✨ Overview

Managing shared money and responsibilities across a group is painful. Group chats get buried, spreadsheets go stale, and there's no single source of truth for who owes what, who did what, and when.

Kith is a production-grade multi-workspace API that solves this. Groups create **containers** — structured wrappers for events, shared pools, or recurring commitments — and Kith handles everything inside them: financial contributions with proof and admin confirmation, task assignment and completion, milestone tracking, dispute resolution, and automated reminders.

It isn't a demo. The system handles recurring billing cycles, idempotent ledger writes, atomic PostgreSQL transactions for financial consistency, a multi-channel notification pipeline with an outbox safety net, and a BullMQ job scheduler with seven distinct background workers.

---

## 🧠 Key Features

**Container System**
A "container" is the core domain object — it can represent a one-time event (wedding, trip, gift), a recurring contribution pool (monthly dues, weekly savings), or any group commitment. Containers support conversion from one-time to recurring, soft deletion with restore, public sharing pages, cover photos, and outcome file uploads. Every feature inside a container — money, tasks, milestones — is opt-in per container.

**Ledger & Financial Tracking**
Members submit contributions with optional proof (images, PDFs). Admins confirm or dispute entries. Corrections are supported as a first-class entry type. The ledger supports idempotency keys on submission to prevent double-recording on retried requests, per-contributor targets with due dates, and multi-currency tracking with a base currency for normalization. Admins can export the full ledger to CSV.

**Recurring Cycle Engine**
Recurring containers auto-generate dated cycles (monthly, quarterly, yearly, or custom cadence) up to 3 months ahead via a BullMQ worker. Admins can override individual cycles: pause the pool, skip a specific member, or adjust a member's target — all resolved from pre-fetched lookup maps in a single DB round trip per worker run, not N queries per cycle.

**Dispute Resolution**
Members can dispute a ledger entry. Raising and resolving a dispute each use a dedicated PostgreSQL RPC (`raise_dispute_atomic`, `resolve_dispute_atomic`) that updates both the dispute and ledger entry status in a single transaction — eliminating the orphaned-state bug that sequential writes introduced.

**Task Management**
Tasks are assignable to members within a container, with due dates, sort order, proof upload, and admin confirmation. Admins can bulk-create tasks, hard-override status, reassign, and export. Overdue tasks are flagged daily by a background worker.

**Multi-Channel Notification Pipeline**
A centralized notification service dispatches across three channels: in-app, push, and email. It uses a template registry with variable interpolation, dedup keys to suppress repeated alerts, and an outbox pattern: if BullMQ enqueue fails, a separate outbox worker scans for stuck deliveries every 5 minutes and re-enqueues them. External channel deliveries use exponential backoff with 3 retry attempts.

**Audit Log**
Every significant action is written to a structured audit log with actor, target, metadata, IP, and user-agent. The log is paginated, filterable by action type and actor, and exportable as CSV with up to 10,000 rows.

**Admin Dashboard**
A single dashboard endpoint aggregates pending confirmations, upcoming contributions, overdue payments, recent activity (with human-readable action descriptions), and workspace stats — in parallel, role-scoped to the caller.

**Cross-Entity Search**
A single workspace-scoped search endpoint queries members and containers in parallel and returns typed results, allowing clients to render them differently without additional round trips.

---

## 🏗️ Architecture Highlights

The application is a single Express server with a clean separation between routing, middleware, controllers, and services. Database access is centralized through Supabase's service-role client — no raw SQL outside of PostgreSQL RPCs.

**Request Lifecycle**
Every authenticated, workspace-scoped request passes through a composed middleware chain:
`requireAuth` → `loadDbUser` → `requireMembership` → `requireAdmin | requireSelfOrAdmin`

`requireAuth` verifies the Supabase JWT and fires a non-blocking `last_seen_at` update. `loadDbUser` fetches an explicit column list (not `select('*')`) to avoid over-fetching on a hot path. `requireMembership` validates active workspace membership and attaches `req.member`. Role guards are applied at the route level, not inside controllers.

**Startup Pre-flight**
The server validates required environment variables before initializing anything else, then checks both database and Redis connectivity before accepting traffic. If either hard dependency fails, the process exits with a clear error. Graceful shutdown handles `SIGTERM` and `SIGINT` with a 10-second force-exit fallback.

**Background Job Architecture**
Seven BullMQ workers run in a dedicated process. A scheduler registers repeatable cron jobs directly into each worker's target queue — avoiding the silent misrouting bug where jobs fire into a queue no worker listens to. Workers use concurrency 1 and are individually responsible for:

- Daily payment and overdue reminders
- Daily cycle lifecycle management (opening upcoming cycles, closing past ones)
- Daily task overdue detection and flagging
- Daily invite link cleanup
- Weekly member engagement scoring
- Daily 3-month-ahead cycle generation
- Every-5-minute notification outbox scan

Batch query patterns are applied where it matters: the engagement check worker runs 3 total queries for all members instead of 2N+1. The cycle generation worker pre-fetches all overrides for a container upfront and resolves them from in-memory Maps inside the generation loop.

**Atomic Consistency**
Financial state changes that span two tables (dispute creation, dispute resolution, workspace creation) are executed as PostgreSQL RPCs inside database transactions. This is an explicit design choice: application-layer two-phase writes are not used where atomicity matters.

**Soft Deletes**
Every entity uses `deleted_at` for soft deletion. All queries filter on `.is('deleted_at', null)`. Containers support admin restore. Members are deactivated rather than hard-deleted.

---

## ⚙️ Tech Stack

**Backend:** Node.js, Express  
**Database & Auth:** Supabase (PostgreSQL, Supabase Auth, Supabase Storage)  
**Job Queue:** BullMQ + Redis  
**Queue Monitor:** Bull Board (IP-whitelisted, Basic Auth protected)  
**Validation:** Zod  
**Error Monitoring:** Sentry  
**Security:** Helmet, CORS, cookie-parser, rate limiting  
**Transport:** Compression, JSON body parsing

---

## 🔐 Authentication & Authorization

Authentication is handled by Supabase Auth. Clients obtain a JWT (via email/password or Google OAuth) and send it as a `Bearer` token. The server verifies the token using the Supabase service-role client — no third-party JWT library is needed.

After token verification, `loadDbUser` loads the user's profile from the database with an explicit column list. User profiles are separate from Supabase auth records and must be explicitly created during registration (`POST /v1/auth/register`).

Authorization is role-based within each workspace. Members have a `role` of either `member` or `admin`. The middleware chain enforces this at the route level:

- `requireAdmin` — 403 for any non-admin
- `requireSelfOrAdmin` — allows the resource owner or any admin; used for profile updates
- `requireMembership` — validates active workspace membership for every workspace-scoped route

Proxy members are a first-class concept: admin-managed members with no Supabase auth account (e.g., a child or non-technical participant). Proxy members only receive in-app notifications; push and email channels are suppressed.

Push tokens and notification preferences (push enabled, email digest) are stored per user and respected by the notification dispatch layer.

---

## 🔄 Core Workflows

**Onboarding**
1. `POST /v1/auth/signup` — creates a Supabase auth user (email + password or Google OAuth)
2. `POST /v1/auth/register` — creates the user's profile record in the database
3. `POST /v1/workspaces` — creates a workspace and atomically makes the creator the first admin via a PostgreSQL RPC
4. `POST /v1/workspaces/:id/invites` — admin generates an invite link (token-based, time-limited)
5. `POST /v1/public/invites/:token/accept` — invitee accepts; they become an active member

**Recording a Contribution**
1. Member calls `POST /v1/workspaces/:id/containers/:id/ledger` with amount and currency
2. Optionally uploads proof: `POST /.../ledger/:entryId/upload-proof` → gets a signed Supabase Storage URL → client uploads directly → `POST /.../confirm-proof` to register the file
3. Admin receives a notification (`contribution_submitted`) and confirms: `POST /.../confirm`
4. Member receives a notification (`contribution_confirmed`)
5. If disputed: `POST /.../dispute` → atomic RPC locks both records → `POST /disputes/:id/resolve` → atomic RPC resolves both

**Recurring Pool Cycle**
1. Admin creates a recurring container with cadence and start date
2. `createContainer` enqueues a `cycle-generation-queue` job immediately
3. Worker generates cycles up to 3 months ahead, applying any pre-fetched pause/skip/adjust overrides
4. Daily cycle lifecycle worker opens upcoming cycles and closes past ones
5. Daily reminder worker scans contributor targets and sends `payment_reminder` or `overdue_reminder` notifications with dedup keys to prevent repeat alerts

---

## 📡 API Overview

All endpoints are versioned under `/v1`. The API returns consistent JSON envelopes:

```json
{ "data": { ... }, "meta": { ... } }
```

Errors follow a typed structure:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "field": "..." } }
```

**Route groups:**

| Prefix | Description |
|---|---|
| `POST /v1/auth/*` | Signup, login, refresh, Google OAuth, profile, avatar, password reset, push token, data export |
| `GET /v1/workspaces` | List workspaces (workspace switcher) |
| `POST /v1/workspaces` | Create workspace |
| `/v1/workspaces/:id/*` | All workspace-scoped resources (members, groups, containers, ledger, disputes, tasks, milestones, audit log) |
| `GET /v1/notifications/*` | User-scoped notification inbox and badge count |
| `GET /v1/public/invites/:token` | Unauthenticated invite preview |
| `GET /v1/public/containers/:token` | Public container progress page |
| `GET /health` | Dependency health check (DB + Redis) |
| `GET /admin/queues` | Bull Board queue monitor (IP + Basic Auth restricted) |

Pagination uses `?page=` and `?per_page=` query parameters. Responses include a `pagination` meta object with `total`. Sort order is controlled by `?sort=field` or `?sort=-field` for descending.

---

## ⚡ Performance & Scalability Notes

**Selective column fetching** — `loadDbUser` and all hot-path queries use explicit column lists instead of `select('*')`. This is enforced as a code-review rule; a comment in the middleware documents why.

**Parallel queries** — The dashboard endpoint, workspace search, engagement check, and container summary all use `Promise.all` to run independent queries concurrently.

**Batch DB access in workers** — The engagement check worker replaced O(2N+1) queries with 3 total: one for all members, one batch join for all ledger entries, one batch join for all tasks. Results are processed in-memory using Maps. The cycle generation worker applies the same pattern for override lookups.

**Idempotency** — Ledger entry creation supports an `X-Idempotency-Key` header. If a duplicate key is detected, the existing entry is returned immediately with `{ idempotent: true }` — safe for client retry logic on network failures.

**Rate limiting** — A general rate limiter covers all routes. Upload endpoints have a stricter dedicated limiter.

**Graceful shutdown** — The server closes the HTTP listener on `SIGTERM`/`SIGINT` and force-exits after 10 seconds if connections don't drain, preventing zombie processes in containerized deployments.

**Redis optionality** — If Redis is unavailable at startup, the server warns and continues without queue support rather than refusing to start. This allows the API to serve non-queue-dependent requests in degraded mode.

---

## 🤖 AI Integration

Kith includes a user-initiated data export flow (`POST /v1/auth/export-data`) that queues an async job via BullMQ to compile and deliver a member's complete data export — designed as a foundation for plugging in AI-powered insights (spending summaries, contribution pattern analysis, anomaly detection) without blocking the request path. The export worker pattern separates data collection from delivery, making it straightforward to enrich exports with model-generated summaries before delivery.

The notification template system (`TEMPLATES` registry with variable interpolation) is also structured to support AI-generated content: the `admin_announcement` template accepts a dynamic `{title}` and `{body}`, which an admin-facing AI layer could populate.

---

## 🚀 Getting Started

**Prerequisites**
- Node.js v18+
- A Supabase project (database + auth + storage configured)
- Redis (local or cloud — Upstash works)

**Installation**

```bash
git clone https://github.com/your-username/kith.git
cd kith
npm install
```

**Environment Setup**

Copy `.env.example` to `.env` and fill in the required values:

```env
# Server
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
API_BASE_URL=http://localhost:3000

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=

# Redis
REDIS_URL=redis://localhost:6379

# Storage
STORAGE_BUCKET_NAME=kith-files

# Queue monitor (optional)
BULL_BOARD_USERNAME=
BULL_BOARD_PASSWORD=
ADMIN_IP_WHITELIST=127.0.0.1,::1

# Error monitoring (optional)
SENTRY_DSN=
```

**Run the API**

```bash
npm run dev
```

**Run the background workers**

```bash
npm run workers
```

Workers and the API server are separate processes. In production, deploy them independently.

**Health check**

```bash
curl http://localhost:3000/health
```

Returns `{ "status": "ok" | "degraded", "db": "...", "redis": "..." }`.

---

## 📂 Project Structure

```
src/
├── app.js                  # Express app setup (middleware, routes, error handler)
├── server.js               # Entry point: env validation, pre-flight, graceful shutdown
│
├── config/
│   ├── database.js         # Supabase client + connection check
│   └── redis.js            # Redis client + connection check
│
├── middleware/
│   ├── auth.js             # requireAuth (JWT verify) + loadDbUser
│   ├── role.js             # requireAdmin, requireSelfOrAdmin
│   ├── workspace.js        # requireMembership (active membership gate)
│   ├── rateLimiter.js      # generalLimiter + uploadLimiter
│   ├── requestLogger.js    # Request ID injection + structured request logging
│   └── errorHandler.js     # Centralized error → response mapping
│
├── routes/                 # Express routers (thin — no logic, only wiring)
│
├── controllers/            # Request handling: parse → validate → DB → response
│   ├── workspace.controller.js
│   ├── container.controller.js
│   ├── ledger.controller.js
│   ├── dispute.controller.js
│   ├── task.controller.js
│   ├── participant.controller.js
│   ├── member.controller.js
│   ├── group.controller.js
│   ├── invite.controller.js
│   ├── milestone.controller.js
│   ├── notification.controller.js
│   └── auth.controller.js
│
├── services/               # Domain logic shared across controllers
│   ├── notification.service.js   # Template render, dedup, multi-channel dispatch
│   ├── audit.service.js          # Structured audit log writes (fire-and-forget)
│   ├── storage.service.js        # Signed upload/download URL generation
│   └── export.service.js         # Ledger + task CSV generation
│
├── validators/             # Zod schemas — all input parsing happens here
│   ├── auth.validator.js
│   ├── workspace.validator.js
│   └── ledger.validator.js
│
├── queues/
│   ├── index.js            # Queue registry (getQueue, getAllQueues)
│   └── scheduler.js        # Repeatable cron job registration
│
├── workers/
│   ├── background_workers.js     # 7 BullMQ workers
│   ├── notification_worker.js    # Push + email delivery worker
│   ├── data_export_worker.js     # Async user data export
│   └── index.js                  # Worker process entry point
│
└── utils/
    ├── errors.js           # Typed error classes (AppError, NotFoundError, etc.)
    ├── response.js         # Consistent response envelope helpers
    ├── logger.js           # Structured logger
    └── crypto.js           # Token generation utilities
```

---

## 🧠 Engineering Decisions

**PostgreSQL RPCs for atomic writes**
Dispute creation and resolution each update two tables: the dispute record and the ledger entry. An application-layer two-step write has an observable failure window between steps, leaving rows in contradictory states. The decision was to push these into database-level transactions via named RPCs (`raise_dispute_atomic`, `resolve_dispute_atomic`). The same pattern is used for workspace creation (`create_workspace_with_admin`), which needs to insert a workspace and a membership atomically.

**BullMQ over in-process `setInterval`**
Scheduled work runs in a separate worker process backed by Redis. This means restarts don't drop pending jobs, multiple worker replicas don't double-process, failed jobs are retried with configurable backoff, and the queue state is observable via Bull Board. In-process scheduling would have none of these properties.

**Outbox pattern for notifications**
The notification service inserts a `notification_deliveries` row before enqueuing. If the enqueue fails (Redis hiccup, network error), the row stays as `status: 'failed'`. The outbox worker runs every 5 minutes and re-enqueues anything stuck for more than 5 minutes. This closes the gap where a dropped enqueue would silently lose a notification with no retry path.

**Dedup keys on notifications**
Background workers that send reminders would fire the same notification every day if unconstrained. Dedup keys (e.g., `payment_reminder:{target_id}:{date}`) are stored on the notification row with a unique constraint. The upsert uses `ignoreDuplicates: true`, so re-running the worker is safe regardless of whether it already fired today.

**Explicit column selection on middleware**
`loadDbUser` runs on every authenticated request. Using `select('*')` there was wasteful — it fetched 20+ columns on every call, most of which no downstream handler needed. The fix was an explicit column list in the middleware itself, with a comment explaining that additional fields should be added there rather than issuing second queries in controllers.

**Role enforcement at the route layer**
Early versions mixed authorization logic into controllers (`if (req.member.role !== 'admin') throw ForbiddenError`). This was refactored to route-level middleware (`requireAdmin`, `requireSelfOrAdmin`). Controllers now assume authorization has already been verified; they contain no role checks. This makes the route file the single source of truth for access policy on each endpoint.

**Soft deletes everywhere**
Hard deletes make debugging production issues very difficult and make data recovery impossible. Every table uses `deleted_at`. Queries filter on `.is('deleted_at', null)`. Containers expose an explicit `/restore` endpoint. Members are deactivated via `is_active: false` and `deleted_at`, not removed.

---

## ⚠️ Known Limitations

- **No real-time updates.** The API is REST; clients poll for notification counts. WebSocket or SSE support for live dashboard updates is not yet implemented.
- **Single-region Redis.** The BullMQ setup assumes a single Redis instance. A multi-region deployment would require Redis Cluster or a managed alternative like Upstash with global replication.
- **Notification delivery is best-effort.** Push and email delivery depends on external providers. The outbox worker improves reliability but cannot guarantee delivery if the provider itself fails.
- **Idempotency key column requires a migration.** The ledger idempotency key feature is guarded with a try/catch that falls through gracefully if the column doesn't yet exist. The migration comment at the top of `ledger.controller.js` must be applied to activate it fully.
- **No test suite committed.** Unit and integration tests are the next priority before any production deployment.

---

## 🚀 Future Improvements

- **WebSocket layer** for live dashboard and notification badge updates
- **Integration tests** using a seeded Supabase test database and Supertest
- **AI-powered contribution summaries** delivered via the existing export job pipeline
- **Multi-currency normalization** via a live exchange rate feed (currently a stored `base_amount` field, but the rate fetch is manual)
- **Admin analytics dashboard** — aggregate spend trends, member engagement scores, and cycle completion rates exposed as dedicated endpoints
- **Mobile push integration** — the delivery worker infra is in place; connecting to APNs/FCM is the remaining step

---

## 📌 Why This Project Stands Out

Most group-finance apps are wrappers around a payments API. Kith isn't about moving money — it's about coordinating the people, proof, and process around it.

The system models real operational complexity: recurring cycles with per-member overrides, financial disputes that need transactional consistency, a notification pipeline that survives queue failures, and a role system granular enough to support proxy members with no auth accounts. Every one of these required deliberate design decisions, not off-the-shelf solutions.

The architecture also shows maturity in the things that don't make demos but matter in production: explicit column fetching on hot paths, batch query optimization in background workers, dedup keys that make scheduled jobs idempotent, atomic RPCs that eliminate race conditions, and a startup sequence that fails fast with clear diagnostics instead of running in a broken state.

---

## 👨‍💻 Author

Built by **[Your Name]**

[GitHub](https://github.com/your-username) · [LinkedIn](https://linkedin.com/in/your-profile)

---

## ⭐ Final Note

Kith is the kind of backend that doesn't show off — it just works correctly under conditions most demo projects never encounter. If you're reading this as an engineer, the codebase is the argument. Start with `workspace.routes.js` for the full API surface, `background_workers.js` for the async layer, and `notification.service.js` for the delivery pipeline.
