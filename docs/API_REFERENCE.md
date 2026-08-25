# Kith API Reference

**Base URL:** `/v1` (mounted relative to wherever the API is deployed; configurable via `API_BASE_URL`)
**Version:** 1.0.0
**Machine-readable spec:** [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1 — import into Swagger UI, Redoc, or Postman)

Kith is a family coordination platform: shared events, recurring
money pools, tasks, milestones, and communication across a household
or extended family ("workspace").

---

## Table of Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Errors](#errors)
- [Rate Limits](#rate-limits)
- [Pagination & Sorting](#pagination--sorting)
- [Endpoints](#endpoints)
  - [Auth](#auth)
  - [Workspaces](#workspaces)
  - [Members](#members)
  - [Invites](#invites)
  - [Groups](#groups)
  - [Containers](#containers)
  - [Participants](#participants)
  - [Ledger](#ledger)
  - [Disputes](#disputes)
  - [Tasks](#tasks)
  - [Milestones](#milestones)
  - [Notifications](#notifications)
  - [Dashboard](#dashboard)
  - [Audit Log](#audit-log)
  - [Public](#public)

---

## Conventions

- All requests/responses are JSON except CSV exports (`text/csv`).
- Every response is wrapped: `{ "data": ... }`. Paginated list endpoints
  add `{ "data": ..., "meta": { "pagination": {...} } }`.
- Monetary amounts are decimal numbers. Every ledger entry carries both
  `original_amount`/`original_currency` (what the contributor actually
  paid) and `base_amount` (converted into the workspace's `base_currency`).
- Timestamps: ISO 8601 datetime. Dates: `YYYY-MM-DD`.
- Most resources are **soft-deleted** (`deleted_at`), not physically removed.
- **`workspace_members.id` vs `users.id`**: almost every "member" reference
  in this API (contributor_id, assigned_to, recipient_id, etc.) is a
  `workspace_members.id`, scoped to one workspace — *not* the underlying
  `users.id`. A proxy member (e.g. a young child with no login) has a
  `workspace_members` row but no `users` row.

### Authorization model

Nearly every endpoint under `/workspaces/{workspaceId}/...` requires the
caller to be an **active member** of that workspace. A non-member gets
`404 Not Found` — not `403` — so workspace existence can't be probed by
status code.

Within a workspace, many actions are restricted to members with
`role: admin`; this is called out per-endpoint below as **"Requires
role=admin."** A few endpoints use a third pattern,
**"self or admin"** — e.g. a member can edit their own display name, and
so can an admin, but nobody else.

---

## Authentication

Kith uses Supabase-issued JWTs.

1. **Get a token** — `POST /auth/signup` or `POST /auth/login` returns
   an `access_token` (short-lived) in the JSON body. A `refresh_token`
   is set as an **httpOnly cookie**, scoped to `/v1/auth/refresh` — it is
   never present in a JSON response body you can read from JS.
2. **Use the token** — send `Authorization: Bearer <access_token>` on
   every subsequent request.
3. **Refresh** — when the access token expires, `POST /auth/refresh`
   (browser sends the httpOnly cookie automatically) returns a new
   `access_token` and rotates the cookie.
4. **Google OAuth** — `GET /auth/google/url` → redirect the user →
   Google redirects back with a `code` → `POST /auth/google/callback`
   exchanges it for a session the same way login does.

### Example: login

```http
POST /v1/auth/login
Content-Type: application/json

{
  "email": "amara@example.com",
  "password": "Correct-Horse-1"
}
```

```json
{
  "data": {
    "access_token": "eyJhbGciOiJI...",
    "expires_in": 3600,
    "token_type": "Bearer",
    "user": {
      "id": "9c1b1e2a-...",
      "email": "amara@example.com",
      "full_name": "Amara Okafor"
    },
    "memberships": [
      {
        "member_id": "3f9a...",
        "role": "admin",
        "display_name": "Amara",
        "workspace_id": "7b21...",
        "workspace_name": "The Okafor Family",
        "base_currency": "USD"
      }
    ],
    "profile_setup_required": false
  }
}
```

`Set-Cookie: refresh_token=...; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth/refresh`

---

## Errors

Every error response has this shape:

```json
{
  "error": {
    "code": "BUSINESS_RULE_VIOLATION",
    "message": "Only pending entries can be edited"
  }
}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Request body/query failed schema validation. Includes a `details` array of `{field, message, code}`. |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired bearer token. |
| 401 | `AUTH_ERROR` | Auth-specific failure (e.g. Supabase error not otherwise mapped). |
| 403 | `FORBIDDEN` | Authenticated but not permitted. |
| 404 | `NOT_FOUND` | Resource not found — **or** caller is not an active member of the workspace (see Authorization model above). |
| 409 | `CONFLICT` | Duplicate resource, already-used invite, duplicate-contribution detection, etc. |
| 422 | `BUSINESS_RULE_VIOLATION` | Well-formed request that violates a business rule (e.g. deleting a container with confirmed ledger entries). |
| 429 | `RATE_LIMITED` | Too many requests — see [Rate Limits](#rate-limits). |
| 500 | `INTERNAL_ERROR` | Unexpected server error. |
| 503 | `SERVICE_UNAVAILABLE` | A dependent service (e.g. email) isn't configured. |

**One documented shape difference:** `POST /workspaces/{workspaceId}/containers`
returns a different, non-standard validation error shape
(`{ error: { message, issues: [...] } }`) instead of the standard
`VALIDATION_FAILED` envelope above. See the [Notes](#api-notes).

---

## Rate Limits

| Limiter | Scope | Limit | Applies to |
|---|---|---|---|
| `authLimiter` | per IP | 5 / minute | signup, login, refresh, forgot-password, google/callback, verify-email |
| `inviteLimiter` | per user | 10 / hour | invite acceptance (both current and legacy paths) |
| `uploadLimiter` | per user | 20 / hour | every `.../upload-url` endpoint |
| `publicLookupLimiter` | per IP | 30 / minute | invite preview, public container view |
| `generalLimiter` | per IP | 200 / minute | global baseline, every route (mounted before auth resolves) |
| `userGeneralLimiter` | per user | 200 / minute | every route under `/workspaces/{workspaceId}/...` |

A rate-limited request returns `429 RATE_LIMITED` with a message
specific to the limiter that tripped.

---

## Pagination & Sorting

Paginated list endpoints accept:

- `page` (default `1`)
- `per_page` (default `20`, max `100`)

...and return:

```json
{
  "data": { "entries": [ /* ... */ ] },
  "meta": {
    "pagination": { "page": 1, "per_page": 20, "total": 47, "total_pages": 3 }
  }
}
```

Sortable endpoints accept `?sort=field` (ascending) or `?sort=-field`
(descending). An unrecognized field silently falls back to that
endpoint's default sort rather than erroring.

---

## Endpoints

Full request/response schemas are in [`openapi.yaml`](./openapi.yaml).
This section gives a scan-able overview plus realistic examples for the
non-obvious endpoints.

### Auth

Base path: `/auth`. All endpoints in this section are outside the
workspace-membership model — they operate on the caller's own user
account.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | Public | Create an account (email + password) |
| POST | `/auth/login` | Public | Log in |
| POST | `/auth/refresh` | Cookie | Rotate access token via refresh cookie |
| POST | `/auth/forgot-password` | Public | Send password-reset email |
| GET | `/auth/google/url` | Public | Get Google OAuth redirect URL |
| POST | `/auth/google/callback` | Public | Exchange OAuth code for a session |
| POST | `/auth/verify-email` | Public | Verify email via OTP token |
| POST | `/auth/logout` | Auth | Log out current session |
| POST | `/auth/logout-all-devices` | Auth | Revoke all sessions |
| POST | `/auth/reset-password` | Auth (recovery session) | Reset password from recovery link |
| POST | `/auth/change-password` | Auth | Change password (requires current password) |
| POST | `/auth/register` | Auth | Complete/upsert profile (idempotent) |
| GET | `/auth/me` | Auth | Current user + memberships |
| PATCH | `/auth/profile` | Auth | Update profile fields |
| POST | `/auth/avatar/upload-url` | Auth | Get signed avatar upload URL |
| GET/POST | `/auth/contacts` | Auth | List / add a contact method |
| PATCH | `/auth/contacts` | Auth | Bulk-replace contacts |
| DELETE | `/auth/contacts/{contactId}` | Auth | Delete a contact method |
| POST | `/auth/push-token` | Auth | Register FCM push token |
| PATCH | `/auth/notification-preferences` | Auth | Toggle push/email digest |
| POST | `/auth/data-export` | Auth | Request a GDPR data export (async, emailed) |

**Password requirements** (signup, reset, change): minimum 8 characters,
maximum 72, at least one uppercase letter, at least one number.

**`POST /auth/register` is idempotent** — safe to call after every login,
not just once. For Google OAuth users, `full_name`/`country_of_residence`
are optional (auto-filled from the Google profile); for email/password
users they're required unless already set.

#### Example: request avatar upload

```http
POST /v1/auth/avatar/upload-url
Authorization: Bearer <token>
Content-Type: application/json

{ "filename": "me.jpg", "content_type": "image/jpeg", "file_size": 84213 }
```

```json
{
  "data": {
    "upload_url": "https://.../storage/v1/object/sign/kith-files/users/9c1b.../avatars/...",
    "file_path": "users/9c1b1e2a-.../avatars/1721234567-abc123.jpg",
    "expires_in": 300
  }
}
```

`PUT` the raw file bytes to `upload_url`, then:

```http
PATCH /v1/auth/profile
Authorization: Bearer <token>
Content-Type: application/json

{ "avatar_url": "users/9c1b1e2a-.../avatars/1721234567-abc123.jpg" }
```

> This same **upload-url → PUT file → confirm/PATCH** pattern is used
> everywhere Kith accepts a file: ledger proofs, task proofs, cover
> photos, outcome files, milestone photos, and workspace avatars — each
> has its own `fileType` with its own size/MIME allowlist (see the
> `UploadFileType` enum in `openapi.yaml`).

---

### Workspaces

Base path: `/workspaces`. A workspace is the top-level "household."

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/workspaces` | Auth | List caller's memberships |
| POST | `/workspaces` | Auth | Create a workspace (caller becomes its first admin) |
| GET | `/workspaces/{id}` | Member | Get workspace details |
| PATCH | `/workspaces/{id}` | Admin | Update workspace |
| DELETE | `/workspaces/{id}` | Admin | Soft-delete workspace |
| GET | `/workspaces/{id}/settings` | Admin | Get settings |
| PATCH | `/workspaces/{id}/settings` | Admin | Update settings (key/value upsert) |
| GET | `/workspaces/{id}/search` | Member | Cross-entity search (members + containers) |
| POST | `/workspaces/{id}/announce` | Admin | Broadcast a notification to all/role-filtered members |
| POST | `/workspaces/{id}/avatar-upload-url` | Admin | Get signed avatar upload URL |

#### Example: create a workspace

```http
POST /v1/workspaces
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "The Okafor Family",
  "base_currency": "USD",
  "family_type": "extended",
  "description": "Shared pool for family events and monthly contributions."
}
```

The creating user is atomically made an `admin` member of the new
workspace as part of the same call.

---

### Members

Base path: `/workspaces/{workspaceId}/members`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/members` | Member | List members (search, filter by role/proxy) |
| POST | `/members` | Admin | Create a member directly (e.g. a proxy) |
| GET | `/members/engagement` | Admin | Per-member engagement stats |
| GET | `/members/{id}` | Member | Get a member |
| PATCH | `/members/{id}` | Self or Admin | Update a member |
| DELETE | `/members/{id}` | Admin | Remove a member |
| GET | `/members/{id}/profile-history` | Admin | Field-level change history |
| GET | `/members/{id}/contribution-summary` | Member | A member's contribution summary |

**Field-level authorization on `PATCH /members/{id}`:** the route allows
the member themself *or* an admin to call it, but several fields
(`role`, `is_proxy`, `proxy_managed_by`, `is_active`, `admin_notes`,
`relationship_category`) are admin-only regardless — a self-edit that
includes any of them returns `403 FORBIDDEN`.

**Proxy members** represent someone without their own login (e.g. a
young child or an elderly relative) who still needs to appear as a
contributor/assignee. `is_proxy: true` members are always managed by an
admin (`proxy_managed_by`) and never receive email/push notifications —
only in-app.

**Last-admin protection:** you cannot demote or remove the workspace's
last remaining admin.

#### Example: creating a proxy member

```http
POST /v1/workspaces/7b21.../members
Authorization: Bearer <token>
Content-Type: application/json

{
  "display_name": "Grandma Ngozi",
  "is_proxy": true,
  "proxy_managed_by": "3f9a-admin-member-id",
  "role": "member",
  "relationship_to_head": "Mother",
  "relationship_category": "blood"
}
```

---

### Invites

Two functionally-identical paths exist:

- **Current:** `POST/GET /workspaces/{workspaceId}/invites`, and
  `GET /public/invites/{token}` + `POST /public/invites/{token}/accept`
- **Legacy:** `GET /invites/{token}/preview` + `POST /invites/{token}/accept`

New integrations should use the current (`/workspaces/.../invites` +
`/public/invites/...`) paths. The legacy `/invites/...` router is kept
for backward compatibility only.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/workspaces/{id}/invites` | Admin | Create an invite link (expires in 7 days) |
| GET | `/workspaces/{id}/invites` | Admin | List invite links |
| DELETE | `/workspaces/{id}/invites/{inviteId}` | Admin | Revoke an invite |
| GET | `/public/invites/{token}` | Public | Preview an invite (always 200; check `is_valid`) |
| POST | `/public/invites/{token}/accept` | Auth | Accept an invite |

**Invite preview never 404s** — it always returns `200` with
`{ is_valid: false, error: "..." }` for a bad/expired/used token, to
avoid leaking which tokens exist.

**Invite acceptance is atomic**: a token can only ever be claimed once,
even under concurrent double-submission, because the claim is a single
conditional `UPDATE ... WHERE used_at IS NULL`.

#### Example: accept an invite

```http
POST /v1/public/invites/aB3dK9.../accept
Authorization: Bearer <token>
```

```json
{
  "data": {
    "workspace": { "id": "7b21...", "name": "The Okafor Family", "base_currency": "USD" },
    "member": { "id": "e4f1...", "role": "member", "display_name": "Amara Okafor" }
  }
}
```

---

### Groups

Base path: `/workspaces/{workspaceId}/groups`. Groups are named subsets
of members, used to bulk-add participants to a container
(`POST .../participants/from-group`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/groups` | Member | List groups |
| POST | `/groups` | Admin | Create a group |
| GET | `/groups/{id}` | Admin | Get a group + full member list |
| PATCH | `/groups/{id}` | Admin | Update name/description |
| DELETE | `/groups/{id}` | Admin | Delete a group |
| POST | `/groups/{id}/members` | Admin | Add members |
| DELETE | `/groups/{id}/members/{memberId}` | Admin | Remove a member (idempotent) |

---

### Containers

Base path: `/workspaces/{workspaceId}/containers`. A **container** is
the core coordination unit — either a one-off **event** (a wedding, a
funeral, a birthday) or a **recurring** money pool (monthly rent, a
standing savings pot).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/containers` | Member | List containers (filter by type/status) |
| POST | `/containers` | Admin | Create a container |
| GET | `/containers/{id}` | Member | Get a container |
| PATCH | `/containers/{id}` | Admin | Update a container |
| DELETE | `/containers/{id}` | Admin | Soft-delete (fails if confirmed ledger entries exist) |
| POST | `/containers/{id}/restore` | Admin | Restore a soft-deleted container |
| POST | `/containers/{id}/complete` | Admin | Mark completed (auto-creates a milestone) |
| POST | `/containers/{id}/convert-to-recurring` | Admin | Convert an event into a recurring pool |
| POST | `/containers/{id}/archive` | Admin | Archive |
| POST | `/containers/{id}/generate-public-link` | Admin | Generate a public share link |
| GET | `/containers/{id}/summary` | Member | Financial summary + per-participant status |
| GET | `/containers/{id}/cycles` | Admin | List cycles (recurring containers) |
| POST | `/containers/{id}/cycles/{cycleId}/override` | Admin | Pause/skip/adjust a cycle |
| POST | `/containers/{id}/outcome-files/upload-url` | Admin | Upload URL for an outcome file |
| POST | `/containers/{id}/cover-photos/upload-url` | Admin | Upload URL for a cover photo |

**Container types:**
- `event` — one-off, has an `event_date`, optional `budget_target`.
- `recurring` — has `recurrence_cadence` (`monthly`/`weekly`/`quarterly`/`yearly`/`custom`), generates `container_cycles` automatically (3 months ahead by default, via a background job).

**Recurring-container fields become required** when `container_type: recurring`:
`recurrence_cadence` and `recurrence_start`. `recurrence_days` is only
meaningful when `recurrence_cadence: custom`.

#### Example: create a recurring pool

```http
POST /v1/workspaces/7b21.../containers
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Monthly Rent Pool",
  "container_type": "recurring",
  "enable_money": true,
  "recurrence_cadence": "monthly",
  "recurrence_start": "2026-08-01",
  "carry_forward_unpaid": true,
  "budget_currency": "USD"
}
```

> ⚠️ **Different error shape on this endpoint:** unlike every other
> endpoint, a validation failure on this specific endpoint returns
> `{ "error": { "message": "...", "issues": [...] } }` instead of the
> standard `VALIDATION_FAILED` envelope. See the
> [Notes](#api-notes).

#### Example: complete an event

```http
POST /v1/workspaces/7b21.../containers/c4a9.../complete
Authorization: Bearer <token>
Content-Type: application/json

{ "outcome_details": "Raised $4,200 toward the venue deposit — thank you everyone!" }
```

This transitions `status: active → completed`, sets `completed_at`, and
automatically creates a corresponding entry in the workspace
[timeline](#milestones).

---

### Participants

Base path: `/workspaces/{workspaceId}/containers/{containerId}/participants`.
A participant links a workspace member to one specific container,
independently toggling `money_enabled`/`tasks_enabled` for that member
in that container.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/participants` | Admin | List participants |
| POST | `/participants` | Admin | Add participants (optionally with an initial target) |
| POST | `/participants/from-group` | Admin | Bulk-add all members of a group |
| PATCH | `/participants/{id}` | Admin | Update a participant |
| DELETE | `/participants/{id}` | Admin | Remove (fails if confirmed ledger entries exist) |
| POST | `/participants/{id}/set-target` | Admin | Set the current contribution target |
| GET | `/participants/{id}/target-history` | Admin | Full target-change history |
| GET | `/participants/{id}/cycle-targets` | Admin | Per-cycle target/payment status |

**All Participant endpoints require `role: admin`** — non-admins never
manage participation directly (they see themselves reflected via
`GET /containers/{id}` → `current_user_participation`).

#### Example: add participants with an initial target

```http
POST /v1/workspaces/7b21.../containers/c4a9.../participants
Authorization: Bearer <token>
Content-Type: application/json

{
  "participants": [
    {
      "workspace_member_id": "e4f1...",
      "money_enabled": true,
      "target": { "amount": 350, "currency": "USD", "due_date": "2026-08-05" }
    },
    { "workspace_member_id": "a1b2...", "money_enabled": true }
  ]
}
```

---

### Ledger

Base path: `/workspaces/{workspaceId}/containers/{containerId}/ledger`
(plus one workspace-wide export at `/workspaces/{workspaceId}/ledger/export`).
This is where money movement is recorded.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/ledger` | Member* | List entries |
| POST | `/ledger` | Member | Record a contribution or expense |
| GET | `/ledger/summary` | Member* | Aggregate totals |
| GET | `/ledger/{id}` | Member* | Get a single entry |
| PATCH | `/ledger/{id}` | Member* | Edit a pending entry |
| DELETE | `/ledger/{id}` | Member* | Delete a pending/proof_uploaded entry |
| POST | `/ledger/{id}/upload-proof` | Member* | Get upload URL for a proof file |
| POST | `/ledger/{id}/confirm-proof` | Member* | Attach an uploaded proof |
| POST | `/ledger/{id}/confirm` | Admin | Confirm a pending/proof_uploaded entry |
| POST | `/ledger/{id}/add-correction` | Admin | Add a correction to a confirmed entry |
| GET | `/ledger/{id}/proof-url` | Member* | Get a signed download URL for a proof |
| DELETE | `/ledger/{id}/proof/{idx}` | Member* | Delete a proof file |
| POST | `/ledger/{id}/dispute` | Member* | Raise a dispute |
| GET | `/{workspaceId}/ledger/export` | Admin | CSV export, workspace-wide |

\* Non-admin members are always scoped to their own entries; admins see
and act on everyone's.

**Entry lifecycle:**

```
 (member submits)         (admin confirms)
   pending ──────────► proof_uploaded ──────────► confirmed ──────► disputed
      │                                                  ▲              │
      └──────────────(admin auto-confirms)────────────────              │
                                                     add-correction ◄────┘
                                                    (creates a new,
                                                     separately-confirmed
                                                     `correction` entry)
```

- Entries submitted by an **admin** are auto-confirmed (`status: confirmed`
  immediately). Entries submitted by a regular member start as `pending`.
- Only `pending` entries can be edited or deleted directly. A `confirmed`
  entry can only be adjusted by adding a **correction** — a separate
  ledger row (`entry_type: correction`) referencing the original.
- `carry_forward` entries are system-generated by the daily cycle-lifecycle
  job when a recurring container has `carry_forward_unpaid: true` and a
  cycle closes with an outstanding balance.

**Idempotency:** send `X-Idempotency-Key: <client-generated-uuid>` on
`POST /ledger`. If the same key is sent again (e.g. a client retry after
a timeout), the *original* entry is returned unchanged with
`{ "idempotent": true }` and HTTP `200` instead of creating a duplicate.

**Duplicate detection (separate from idempotency):** even without an
idempotency key, submitting the same container + contributor + amount
within a 10-minute window returns `409 CONFLICT` unless `?force=true` is set.

#### Example: record a contribution

```http
POST /v1/workspaces/7b21.../containers/c4a9.../ledger
Authorization: Bearer <token>
X-Idempotency-Key: 8f14e45f-ceea-4d5a-...
Content-Type: application/json

{
  "entry_type": "contribution",
  "original_amount": 350,
  "original_currency": "USD",
  "base_amount": 350,
  "payment_method": "bank_transfer",
  "note": "August rent share"
}
```

```json
{
  "data": {
    "entry": {
      "id": "d8a2...",
      "status": "pending",
      "entry_type": "contribution",
      "original_amount": 350,
      "original_currency": "USD",
      "base_amount": 350,
      "contributor_id": "e4f1...",
      "recorded_at": "2026-07-22T14:02:11.000Z"
    }
  }
}
```

#### Example: add a correction to a confirmed entry

```http
POST /v1/workspaces/7b21.../containers/c4a9.../ledger/d8a2.../add-correction
Authorization: Bearer <token>
Content-Type: application/json

{
  "original_amount": -50,
  "original_currency": "USD",
  "base_amount": -50,
  "note": "Refunded $50 — duplicate charge from bank transfer"
}
```

Response wraps the new row as `correction_entry` (not `entry` — a
deliberate naming difference from the other ledger endpoints, since a
correction is a distinct record from what it corrects).

---

### Disputes

Base path: `/workspaces/{workspaceId}/disputes`. A dispute is raised
against a specific ledger entry (via `POST .../ledger/{entryId}/dispute`,
documented under Ledger above) and then managed here at the workspace level.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/disputes` | Admin | List disputes |
| GET | `/disputes/{id}` | Raiser or Admin | Get a dispute + its ledger entry |
| POST | `/disputes/{id}/note` | Raiser or Admin | Add a note |
| POST | `/disputes/{id}/resolve` | Admin | Resolve |

Resolving a dispute is atomic — the dispute's `status` and the
underlying ledger entry's `status` are updated together via a single
database transaction, so they can never disagree.

---

### Tasks

Base path: `/workspaces/{workspaceId}/containers/{containerId}/tasks`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/tasks` | Member* | List tasks |
| POST | `/tasks` | Admin | Create a task |
| POST | `/tasks/bulk` | Admin | Create up to 50 tasks at once |
| GET | `/tasks/export` | Member* | CSV export |
| GET | `/tasks/{id}` | Member* | Get a task |
| PATCH | `/tasks/{id}` | Assignee or Admin | Update a task |
| DELETE | `/tasks/{id}` | Admin | Delete |
| PATCH | `/tasks/{id}/reassign` | Admin | Reassign |
| PATCH | `/tasks/{id}/status` | Admin | Hard status override |
| POST | `/tasks/{id}/confirm` | Admin | Confirm a completed task |
| POST | `/tasks/{id}/upload-proof` | Assignee or Admin | Get upload URL |
| POST | `/tasks/{id}/confirm-proof` | Assignee or Admin | Attach uploaded proof |
| DELETE | `/tasks/{id}/proof/{idx}` | Assignee or Admin | Delete a proof file |

\* Non-admins only see/export tasks assigned to them.

**Non-admin edit restriction:** on `PATCH /tasks/{id}`, a non-admin
(even the assignee) may only set `status` (to `in_progress` or
`completed`) and/or `completion_note`. Any other field in the request
body returns `403 FORBIDDEN`. Reassignment, due-date changes, and hard
status overrides are admin-only, separate endpoints.

#### Example: bulk-create chores

```http
POST /v1/workspaces/7b21.../containers/c4a9.../tasks/bulk
Authorization: Bearer <token>
Content-Type: application/json

{
  "tasks": [
    { "title": "Book the caterer", "assigned_to": "e4f1...", "due_date": "2026-08-10" },
    { "title": "Confirm guest count", "due_date": "2026-08-12" }
  ]
}
```

```json
{
  "data": {
    "created": [ { "id": "t1...", "title": "Book the caterer", "status": "pending" }, { "id": "t2...", "title": "Confirm guest count", "status": "pending" } ],
    "failed": []
  }
}
```

Each task is processed independently — one bad row doesn't roll back
the rest; check the `failed` array (`{ index, error }`) for per-item
failures.

---

### Milestones

Base path: `/workspaces/{workspaceId}` (mounted at the workspace root,
not under `/milestones`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/timeline` | Member | Merged, date-sorted feed of completed containers + milestones |
| POST | `/milestones` | Admin | Create a milestone |
| GET | `/milestones/{id}` | Member | Get a milestone |
| PATCH | `/milestones/{id}` | Admin | Update |
| DELETE | `/milestones/{id}` | Admin | Soft-delete |
| POST | `/milestones/{id}/photos/upload-url` | Admin | Get upload URL |
| POST | `/milestones/{id}/photos/confirm` | Admin | Attach uploaded photo |

The **timeline** merges two independent sources — completed containers
and standalone milestones — sorted together by date. Pagination uses
**per-source cursors** (`before_container`, `before_milestone`) rather
than one shared cursor, so an uneven split between the two sources on
one page can never cause the next page to skip an item. A bare `before`
param (from a first "load more" tap) seeds both cursors identically.

---

### Notifications

Base path: `/notifications` — **user-scoped, not workspace-scoped** in
the URL, even though each individual notification belongs to one
workspace membership.

| Method | Path | Description |
|---|---|---|
| GET | `/notifications` | Paginated list (filter by `is_read`, `workspace_id`) |
| GET | `/notifications/count` | Lightweight unread-count (for badges) |
| PATCH | `/notifications/read-all` | Mark all read (optionally scoped to one workspace) |
| PATCH | `/notifications/{id}/read` | Mark one read |

If `workspace_id` isn't passed, these endpoints resolve to the caller's
**most-recently-joined active membership** — for a user in multiple
workspaces, always pass `workspace_id` explicitly to avoid ambiguity.

---

### Dashboard

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/workspaces/{id}/dashboard` | Member | Aggregated dashboard: summary counts, active events, recurring pools, upcoming deadlines, pending confirmations (admin only), recent activity, unread count |
| GET | `/workspaces/{id}/overdue-summary` | Admin | Per-member outstanding balances across all active containers |

---

### Audit Log

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/workspaces/{id}/audit-log` | Admin | Paginated, filterable (`action`, `actor_member_id`, `from`, `to`) |
| GET | `/workspaces/{id}/audit-log/export` | Admin | CSV export, same filters, capped at 10,000 rows |

See `constants/audit-actions.js` in the source for the full catalog of
`action` values (e.g. `container.created`, `ledger.confirmed`,
`member.removed`, `dispute.resolved`).

---

### Public

Unauthenticated endpoints, rate-limited against enumeration
(`publicLookupLimiter`, 30/min/IP).

| Method | Path | Description |
|---|---|---|
| GET | `/public/invites/{token}` | Preview an invite (always 200; check `is_valid`) |
| POST | `/public/invites/{token}/accept` | Accept an invite (requires auth) |
| GET | `/public/containers/{publicToken}` | Read-only shared container view |

The public container view respects `public_show_names` — contributor
names and paid/pending status are only included in the response if the
container owner enabled that flag when generating the public link.

---

## API Notes

A short reference for a couple of intentional shape differences that are
easy to trip over when building a client:

1. **Non-standard validation error on `POST /containers`.** Every other
   endpoint's validation failures flow through Zod's `.parse()` →
   the global error handler → the standard
   `{ error: { code: VALIDATION_FAILED, message, field, details } }`
   shape. `container.controller.js#createContainer` instead uses
   `.safeParse()` and hand-rolls its own `400` response:
   `{ error: { message, issues: [{ path, message, code }] } }` — no
   top-level `code`, and `issues` uses `path` (dot-joined) rather than
   `field`. A generic client-side error handler built against the
   standard shape will need a special case for this one endpoint.

2. **`GET /workspaces/{id}` returns two differently-cased member
   shapes.** `current_member` (from `req.member`, set by the
   `requireMembership` middleware) is `{ id, role, displayName,
   isProxy, isActive, workspaceId }` — camelCase. Every other "member"
   object returned anywhere else in the API (list members, get member,
   ledger `contributor_name`, etc.) is a snake_case `workspace_members`
   row. A client that has one `Member` deserializer will need a special
   case for this one field.

3. **`add-correction` wraps its result as `correction_entry`, not
   `entry`.** Every other ledger write endpoint (`POST /ledger`,
   `PATCH /ledger/{id}`, `POST /ledger/{id}/confirm`,
   `POST /ledger/{id}/confirm-proof`) wraps the ledger row as `entry`.
   `add-correction`'s response is `{ correction_entry: {...} }` — a
   deliberate distinction (a correction is a separate row from what it
   corrects) but worth calling out since it breaks a "the ledger
   endpoints all return `{ entry }`" assumption.

4. **`overdue_count` in `MemberEngagementItem` is reserved for future
   use** and currently always returns `0`. It's part of the documented
   response shape but a consumer should not rely on this field having a
   meaningful value yet.

5. **Notification endpoints without `workspace_id` pick the
   "most-recently-joined active membership."** `notification.routes.js`'s
   `resolveMember` middleware falls back to
   `ORDER BY joined_at DESC LIMIT 1` across the caller's active
   memberships when no `workspace_id` is given. For a user in more than
   one workspace this is easy to get wrong client-side; always pass
   `workspace_id` explicitly if the app supports multi-workspace users.

6. **`deleteMember`'s `force` query param is a literal string, not a
   boolean.** The route/service compares `force === 'true'` — sending
   `?force=true` (string) works as expected. Documented in the OpenAPI
   schema as `enum: ['true', 'false']` rather than `type: boolean` for
   this reason.

7. **Two invite-acceptance paths exist by design.**
   `POST /invites/{token}/accept` (legacy) and
   `POST /public/invites/{token}/accept` (current) are functionally
   identical — both route to the same underlying logic. The legacy path
   is kept for backward compatibility; new integrations should use the
   `/public/invites/...` path.

8. **Several endpoints enforce authorization in the *service* layer,
   not via route middleware**, which means the OpenAPI `security`
   annotations alone don't fully capture who can call what:
    - `PATCH /members/{id}` — route allows self-or-admin;
      admin-only *fields* are enforced inside `member.service.js`.
    - `PATCH /tasks/{id}` — no route-level admin gate; the assignee vs.
      admin vs. allowed-fields split is entirely in
      `task.service.js#updateTask`.
    - `POST /ledger/{id}/confirm-proof`, `POST /ledger/{id}/dispute` —
      no route-level admin gate; contributor-or-admin check is in the
      service.
    This is intentional layering — the "Requires role=admin" / "Self or
    Admin" / "Assignee or Admin" callouts used throughout this document
    are the authoritative source for who can call what, rather than the
    route table alone.

---

## Schema Notes

- **`ContainerStatus`** includes `archived`, which is set by service logic
  (`archiveContainer`) rather than appearing directly in a client-facing
  Zod enum.
- **`LedgerEntryType`** includes `correction` and `carry_forward`, which
  are system/service-set values never present in the client-facing
  `createLedgerEntrySchema` (`entry_type` there only accepts
  `contribution`/`expense`).
- **`PaymentMethod` normalization on create vs. update** differs
  intentionally: the create schema accepts free-text synonyms and
  normalizes them server-side (rejecting anything unrecognized); the
  update schema only accepts the canonical enum values directly.
- **CSV export response bodies** are documented as `type: string,
  format: binary` under `text/csv` — the actual column sets are
  described in prose (matching `export.service.js`'s explicit header
  arrays) since OpenAPI has no native tabular-schema representation.
- Where a request or response field's exact validation constraint
  (`minLength`, `maxLength`, enum membership, etc.) is defined directly
  by a Zod schema, that constraint is transcribed exactly here. Where
  behavior is service-layer logic (e.g. the 10-minute duplicate-detection
  window, the 7-day invite expiry, the 30-second membership cache TTL),
  it's described in prose rather than as a formal schema constraint,
  since these are runtime/business values rather than input-validation
  rules.
