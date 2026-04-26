# Kith API Documentation

> **Version:** 1.0.0  
> **Last Updated:** April 2026  
> **Classification:** External Developer & Internal Engineering Reference

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication](#2-authentication)
3. [Base URL & Environments](#3-base-url--environments)
4. [Global Standards](#4-global-standards)
5. [Authorization Model](#5-authorization-model)
6. [API Endpoints](#6-api-endpoints)
   - 6.1 [System](#61-system)
   - 6.2 [Auth & User](#62-auth--user)
   - 6.3 [Workspaces](#63-workspaces)
   - 6.4 [Members](#64-members)
   - 6.5 [Invites](#65-invites)
   - 6.6 [Groups](#66-groups)
   - 6.7 [Containers](#67-containers)
   - 6.8 [Participants](#68-participants)
   - 6.9 [Ledger](#69-ledger)
   - 6.10 [Disputes](#610-disputes)
   - 6.11 [Tasks](#611-tasks)
   - 6.12 [Milestones & Timeline](#612-milestones--timeline)
   - 6.13 [Notifications](#613-notifications)
   - 6.14 [Public Endpoints](#614-public-endpoints)
7. [Pagination, Filtering & Sorting](#7-pagination-filtering--sorting)
8. [File Uploads](#8-file-uploads)
9. [Background Jobs & Async Behavior](#9-background-jobs--async-behavior)
10. [Real-Time / Events](#10-real-time--events)
11. [Data Consistency & Constraints](#11-data-consistency--constraints)
12. [Security Considerations](#12-security-considerations)
13. [Common Workflows](#13-common-workflows)
14. [Missing / Weak Endpoints](#14-missing--weak-endpoints)
15. [API Quality Assessment](#15-api-quality-assessment)

---

## 1. Overview

### What the API Does

Kith is a **team financial accountability and contribution tracking platform**. The API supports multi-workspace, multi-role teams that collectively manage contribution pools ("containers"), track ledger entries (payments/contributions), assign and verify tasks, raise and resolve disputes, and receive real-time notifications.

The backend is a **Node.js / Express REST API** backed by **Supabase (PostgreSQL)** for storage and auth, **Redis + BullMQ** for background job queues, and **Firebase Cloud Messaging** for push notifications.

### Core Concepts

| Concept | Description |
|---|---|
| **Workspace** | The top-level organizational unit. All resources belong to a workspace. |
| **Member** | A user's identity within a workspace. One user can be a member of multiple workspaces. |
| **Role** | Either `admin` or `member`. Controls what actions are permitted. |
| **Container** | A contribution pool or savings group. Can be one-time or recurring. |
| **Participant** | A member enrolled in a specific container. |
| **Ledger Entry** | A financial transaction record within a container (contribution, correction, carry-forward). |
| **Cycle** | A time period within a recurring container (monthly, quarterly, yearly, custom). |
| **Task** | An action item assigned to a participant within a container. |
| **Milestone** | A timeline event attached to a workspace. |
| **Dispute** | A formal objection raised against a ledger entry. |
| **Group** | A named subset of workspace members, usable for batch participant enrollment. |
| **Notification** | An in-app (and optionally push/email) alert delivered to workspace members. |
| **Proxy Member** | A member record that represents a non-user entity. Proxy members never receive external notifications (push/email). |

### High-Level System Behavior

- Every authenticated request updates the caller's `last_seen_at` timestamp (fire-and-forget, non-blocking).
- Workspace membership is verified on **every** workspace-scoped request. Non-members receive `404` (not `403`) to prevent workspace enumeration.
- Soft-deletes (`deleted_at`) are used throughout — hard deletes are avoided for auditability.
- Background workers handle reminders, overdue detection, cycle lifecycle management, and notification delivery retries.

---

## 2. Authentication

### Strategy

Kith uses **Supabase Auth** (JWT-based). Every issued token is a standard JWT signed by Supabase. The server validates tokens server-side using the Supabase Admin SDK (`supabaseAdmin.auth.getUser(token)`), not by decoding locally.

### How to Authenticate Requests

Include the Supabase `access_token` as a Bearer token in the `Authorization` header on every authenticated request:

```
Authorization: Bearer <access_token>
```

### Token Format

Tokens are JWTs issued by Supabase. They are **not** decoded on the server — they are sent to Supabase for validation. The decoded payload includes `sub` (user UUID), `email`, and `user_metadata.full_name`.

### Session Flow

```
1. POST /v1/auth/signup        → Supabase creates user, sends verification email
2. POST /v1/auth/verify-email  → Exchange OTP token from email link for a session
3. POST /v1/auth/register      → Complete/upsert profile in the `users` table
4. POST /v1/auth/login         → Returns { access_token, refresh_token }
5. (use access_token on all requests via Authorization: Bearer <token>)
6. POST /v1/auth/refresh       → Exchange refresh_token for a new access_token
7. POST /v1/auth/logout        → Invalidate current session
```

For **Google OAuth**:
```
1. GET  /v1/auth/google/url         → Returns { url } — frontend opens this URL
2. POST /v1/auth/google/callback    → Exchange OAuth code for session tokens
3. POST /v1/auth/register           → Complete profile (same as email flow)
```

### Example Request Headers

```http
GET /v1/auth/me HTTP/1.1
Host: api.kith.app
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
X-Request-Id: req_abc123   (optional — auto-generated if omitted)
```

---

## 3. Base URL & Environments

| Environment | Base URL |
|---|---|
| Local | `http://localhost:3000` |
| Production | Configured via `API_BASE_URL` environment variable |

All endpoints are prefixed with `/v1`.

**Example full URL:**
```
https://api.kith.app/v1/auth/me
```

---

## 4. Global Standards

### Request Format

- **Content-Type:** `application/json`
- **Body size limit:** 1 MB
- **Encoding:** UTF-8
- All IDs are **UUIDs** (v4 format). Passing non-UUID IDs to workspace-scoped routes returns `404`.

### Request Headers

| Header | Required | Description |
|---|---|---|
| `Authorization` | Yes (on authenticated routes) | `Bearer <access_token>` |
| `Content-Type` | Yes (on POST/PATCH) | `application/json` |
| `X-Request-Id` | No | Custom request ID. Auto-generated by server if absent. Reflected in `X-Request-Id` response header and all log entries. |

### Response Format

**Success:**
```json
{
  "data": { ... }
}
```

**Success with pagination:**
```json
{
  "data": [ ... ],
  "meta": {
    "pagination": {
      "page": 1,
      "per_page": 20,
      "total": 143,
      "total_pages": 8
    }
  }
}
```

**Created (HTTP 201):**
```json
{
  "data": { "id": "uuid", ... }
}
```

**No Content (HTTP 204):** Empty body.

### Error Response Format

All errors follow a single consistent envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "field": "fieldName",        // present on validation errors
    "details": [ ... ]          // present on multi-field validation errors
  }
}
```

### Standard Error Codes

| HTTP Status | Code | Trigger |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod schema failure or bad input |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired JWT |
| 403 | `FORBIDDEN` | Authenticated but insufficient role |
| 404 | `NOT_FOUND` | Resource not found or workspace enumeration guard |
| 409 | `CONFLICT` | Unique constraint violation (Postgres `23505`) |
| 422 | `BUSINESS_RULE_VIOLATION` | Business logic failure or FK violation |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unhandled server error (message redacted in production) |

### Validation Error Example

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Expected string, received number",
    "field": "name",
    "details": [
      { "field": "name", "message": "Expected string, received number", "code": "invalid_type" }
    ]
  }
}
```

---

## 5. Authorization Model

### Roles

| Role | Description |
|---|---|
| `admin` | Full control over workspace settings, members, containers, ledger, disputes, tasks, and invites. |
| `member` | Read access to most resources. Can submit their own ledger entries, manage their own tasks and proofs, and view their own profile. |

### Middleware Chain (Workspace-Scoped Routes)

Every request to `/v1/workspaces/:workspaceId/*` passes through:

```
requireAuth → loadDbUser → requireMembership → [requireAdmin] → controller
```

1. **`requireAuth`** — Validates the Bearer JWT via Supabase. Populates `req.user`.
2. **`loadDbUser`** — Fetches the `users` row. Rejects if `deleted_at` is set. Populates `req.dbUser`.
3. **`requireMembership`** — Confirms the user is an active member of the target workspace. Populates `req.member` and `req.workspace`. Returns `404` (not `403`) on failure.
4. **`requireAdmin`** — Checks `req.member.role === 'admin'`. Returns `403` on failure. Applied per-route for admin-only operations.
5. **`requireSelfOrAdmin`** — Allows the resource's owner **or** any admin. Used on `PATCH /members/:memberId`.

### Workspace Isolation

- All queries are scoped to `workspace_id`. A member of Workspace A cannot access any resource in Workspace B.
- The workspace ID is always sourced from the **URL path** (`:workspaceId`), never from the request body, preventing injection attacks.
- Non-member access to a workspace returns `404`, never `403`, to prevent workspace existence enumeration.

### Proxy Members

Members flagged `is_proxy = true` represent non-user entities (e.g., a tracked third-party). They are never sent push or email notifications.

---

## 6. API Endpoints

> **Auth column legend:**
> - 🔓 Public — no JWT required
> - 🔒 Authenticated — valid JWT required
> - 👑 Admin — workspace `admin` role required
> - 🧑‍🤝‍🧑 Self or Admin — resource owner or admin

---

### 6.1 System

#### `GET /health`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Description** | Infrastructure health check. Returns status of database and Redis connections. |

**Response `200`:**
```json
{
  "status": "ok",
  "db": "connected",
  "redis": "connected",
  "version": "1.0.0",
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

**Response `503` (degraded):**
```json
{
  "status": "degraded",
  "db": "connected",
  "redis": "error",
  "version": "1.0.0",
  "timestamp": "2026-04-25T12:00:00.000Z"
}
```

**Notes:** Use this endpoint for load balancer and uptime monitoring probes.

---

### 6.2 Auth & User

All routes are mounted at `/v1/auth`.

---

#### `POST /v1/auth/signup`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Creates a new Supabase user and sends an email verification link. Does **not** create a profile row — call `POST /v1/auth/register` after email verification. |

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response `201`:**
```json
{
  "data": {
    "message": "Verification email sent. Please check your inbox."
  }
}
```

**Error Cases:**
- `400 VALIDATION_FAILED` — Invalid email or weak password.
- `409 CONFLICT` — Email already registered.

---

#### `POST /v1/auth/login`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Authenticates with email and password. Returns a session. |

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response `200`:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "user": {
      "id": "uuid",
      "email": "user@example.com"
    }
  }
}
```

**Error Cases:**
- `401 UNAUTHORIZED` — Invalid credentials.
- `429 RATE_LIMITED` — Too many attempts.

---

#### `POST /v1/auth/refresh`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Exchanges a refresh token for a new access token. |

**Request Body:**
```json
{
  "refresh_token": "..."
}
```

**Response `200`:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "..."
  }
}
```

**Error Cases:**
- `401 UNAUTHORIZED` — Refresh token invalid or expired.

---

#### `POST /v1/auth/forgot-password`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Sends a password reset email. Always returns success regardless of whether the email exists — this prevents user enumeration. |

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response `200`:**
```json
{
  "data": { "message": "If that email is registered, a reset link has been sent." }
}
```

---

#### `GET /v1/auth/google/url`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Description** | Returns the Google OAuth redirect URL. The frontend navigates to this URL to begin the OAuth flow. |

**Response `200`:**
```json
{
  "data": { "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
}
```

---

#### `POST /v1/auth/google/callback`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Exchanges the OAuth authorization code returned by Google for a Supabase session. |

**Request Body:**
```json
{
  "code": "4/0AX4XfW..."
}
```

**Response `200`:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "user": { "id": "uuid", "email": "user@example.com" }
  }
}
```

---

#### `POST /v1/auth/verify-email`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Rate Limit** | 5 requests / minute / IP |
| **Description** | Exchanges the OTP token from the email verification link for a full session. Must be called after the user clicks the verification link in their email. |

**Request Body:**
```json
{
  "token_hash": "...",
  "type": "email"
}
```

**Response `200`:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "..."
  }
}
```

---

#### `POST /v1/auth/logout`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Invalidates the current session token. |

**Response `200`:**
```json
{
  "data": { "message": "Logged out successfully." }
}
```

---

#### `POST /v1/auth/logout-all-devices`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Revokes all active sessions for the current user across all devices. |

**Response `200`:**
```json
{
  "data": { "message": "All sessions revoked." }
}
```

---

#### `POST /v1/auth/reset-password`

| | |
|---|---|
| **Auth** | 🔒 Authenticated (short-lived recovery JWT from reset email) |
| **Description** | Resets the user's password. The `Authorization` header must carry the short-lived recovery JWT extracted from the reset email link, not a regular access token. |

**Request Body:**
```json
{
  "password": "NewSecurePass456!"
}
```

**Response `200`:**
```json
{
  "data": { "message": "Password updated successfully." }
}
```

---

#### `POST /v1/auth/register`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Creates or updates the user's profile row in the `users` table. Idempotent — safe to call multiple times. Must be called after initial signup/Google OAuth to complete onboarding. |

**Request Body:**
```json
{
  "full_name": "Jane Doe",
  "timezone": "America/New_York",
  "preferred_language": "en"
}
```

**Response `200`:**
```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "full_name": "Jane Doe",
    "timezone": "America/New_York"
  }
}
```

---

#### `GET /v1/auth/me`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Returns the current user's profile and their workspace memberships. |

**Response `200`:**
```json
{
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "full_name": "Jane Doe",
    "avatar_url": "https://...",
    "timezone": "America/New_York",
    "preferred_language": "en",
    "push_enabled": true,
    "email_digest_enabled": false,
    "memberships": [
      {
        "workspace_id": "uuid",
        "workspace_name": "Team Alpha",
        "role": "admin",
        "display_name": "Jane"
      }
    ]
  }
}
```

---

#### `PATCH /v1/auth/profile`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Updates the current user's profile fields. All fields are optional. |

**Request Body (all fields optional):**
```json
{
  "full_name": "Jane Smith",
  "bio": "Building things.",
  "country": "US",
  "timezone": "America/Chicago",
  "avatar_url": "https://storage.example.com/avatars/uuid.jpg"
}
```

**Response `200`:**
```json
{
  "data": { "id": "uuid", "full_name": "Jane Smith", ... }
}
```

---

#### `POST /v1/auth/avatar/upload-url`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a profile avatar directly to storage. After upload, call `PATCH /v1/auth/profile` with the resulting `avatar_url`. |

**Request Body:**
```json
{
  "file_name": "profile.jpg",
  "content_type": "image/jpeg"
}
```

**Response `200`:**
```json
{
  "data": {
    "upload_url": "https://storage.supabase.co/...",
    "avatar_url": "https://storage.supabase.co/avatars/uuid/profile.jpg"
  }
}
```

**Notes:** Upload directly to `upload_url` via `PUT` with the `Content-Type` header set. Then persist `avatar_url` via `PATCH /v1/auth/profile`.

---

#### `PATCH /v1/auth/contacts`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Replaces all contact methods for the current user (phone, WhatsApp, social, etc.). This is a full replacement — omitted contacts are removed. |

**Request Body:**
```json
{
  "contacts": [
    { "type": "phone", "value": "+14155552671" },
    { "type": "whatsapp", "value": "+14155552671" },
    { "type": "instagram", "value": "@janedoe" }
  ]
}
```

**Response `200`:**
```json
{
  "data": { "contacts": [ ... ] }
}
```

---

#### `GET /v1/auth/contacts`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Returns all contact methods for the current user. |

---

#### `POST /v1/auth/contacts`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Upserts a single contact method. |

**Request Body:**
```json
{
  "type": "twitter",
  "value": "@janedoe"
}
```

---

#### `DELETE /v1/auth/contacts/:contactId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Removes a single contact method by ID. |

**Response `204`:** No content.

---

#### `POST /v1/auth/push-token`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Registers or updates the FCM push notification token for the current user's device. |

**Request Body:**
```json
{
  "token": "fcm-device-token-string",
  "platform": "ios"
}
```

**Response `200`:**
```json
{
  "data": { "message": "Push token registered." }
}
```

**Notes:** `platform` should be `ios` or `android`. This token is used by the notification worker to send push messages via Firebase Cloud Messaging.

---

#### `PATCH /v1/auth/notification-preferences`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Enables or disables push notifications and email digest for the current user. |

**Request Body:**
```json
{
  "push_enabled": true,
  "email_digest_enabled": false
}
```

**Response `200`:**
```json
{
  "data": { "push_enabled": true, "email_digest_enabled": false }
}
```

---

#### `POST /v1/auth/data-export`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Queues a GDPR data export job. The export is assembled asynchronously and emailed to the user when complete. The response is immediate (the job runs in the background). |

**Request Body:** None.

**Response `202`:**
```json
{
  "data": { "message": "Your data export has been queued. You will receive an email when it is ready." }
}
```

**Side Effects:** Adds a job to the background queue. No export is generated synchronously.

---

### 6.3 Workspaces

---

#### `GET /v1/workspaces`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Returns all workspaces the current user is an active member of. Used for the workspace switcher and onboarding. |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Team Alpha",
      "base_currency": "USD",
      "visibility": "private",
      "role": "admin"
    }
  ]
}
```

---

#### `POST /v1/workspaces`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Creates a new workspace. The calling user automatically becomes the first `admin` member. |

**Request Body:**
```json
{
  "name": "Team Alpha",
  "base_currency": "USD",
  "visibility": "private"
}
```

**Response `201`:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Team Alpha",
    "base_currency": "USD",
    "visibility": "private"
  }
}
```

---

#### `GET /v1/workspaces/:workspaceId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns workspace details. |

**Path Parameters:**
- `workspaceId` — UUID of the workspace.

**Response `200`:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Team Alpha",
    "base_currency": "USD",
    "visibility": "private",
    "bank_details": { ... }
  }
}
```

---

#### `PATCH /v1/workspaces/:workspaceId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates workspace name, currency, visibility, or other settings. |

**Request Body (all fields optional):**
```json
{
  "name": "Team Alpha 2.0",
  "base_currency": "GBP",
  "visibility": "public"
}
```

**Response `200`:**
```json
{
  "data": { "id": "uuid", "name": "Team Alpha 2.0", ... }
}
```

---

#### `DELETE /v1/workspaces/:workspaceId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Soft-deletes the workspace. All workspace resources become inaccessible. |

**Response `204`:** No content.

**Edge Cases:** This is irreversible from the API — there is no restore endpoint for workspaces.

---

#### `GET /v1/workspaces/:workspaceId/dashboard`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns aggregated dashboard data for the workspace — active containers, recent ledger activity, member summaries, etc. |

**Response `200`:**
```json
{
  "data": { ... }
}
```

---

#### `GET /v1/workspaces/:workspaceId/settings`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns the full workspace settings object. |

---

#### `PATCH /v1/workspaces/:workspaceId/settings`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates workspace-level settings (notifications, rules, etc.). |

---

#### `GET /v1/workspaces/:workspaceId/search`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Cross-entity search across members and containers within the workspace. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `q` | string | Search query string |

**Response `200`:**
```json
{
  "data": {
    "members": [ { "id": "uuid", "display_name": "Jane" } ],
    "containers": [ { "id": "uuid", "name": "Monthly Pool" } ]
  }
}
```

---

#### `POST /v1/workspaces/:workspaceId/announce`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Sends an `admin_announcement` notification to all (or role-filtered) workspace members. |

**Request Body:**
```json
{
  "message": "The monthly contribution is due this Friday.",
  "role_filter": "member"
}
```

**Response `200`:**
```json
{
  "data": { "recipients_count": 12 }
}
```

**Notes:** `role_filter` is optional. If omitted, all active members receive the announcement.

---

#### `GET /v1/workspaces/:workspaceId/audit-log`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns a paginated, filterable audit log of workspace actions. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `page` | integer | Page number (default: 1) |
| `per_page` | integer | Results per page (default: 20) |
| `action` | string | Filter by action type |
| `actor_id` | UUID | Filter by member who performed the action |
| `from` | ISO 8601 date | Start of date range |
| `to` | ISO 8601 date | End of date range |

---

#### `GET /v1/workspaces/:workspaceId/audit-log/export`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Exports the full audit log as a downloadable file (CSV or JSON). |

---

#### `GET /v1/workspaces/:workspaceId/overdue-summary`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns an aggregated overdue contribution summary across all active containers in the workspace. |

---

#### `POST /v1/workspaces/:workspaceId/avatar-upload-url`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a workspace avatar. After upload, call `PATCH /v1/workspaces/:workspaceId` with the resulting `avatar_url`. |

---

### 6.4 Members

All routes are under `/v1/workspaces/:workspaceId/members`.

---

#### `GET /v1/workspaces/:workspaceId/members`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a paginated list of workspace members. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `page` | integer | Page number |
| `per_page` | integer | Results per page |
| `role` | `admin` \| `member` | Filter by role |
| `q` | string | Search by display name |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "display_name": "Jane Doe",
      "role": "admin",
      "is_proxy": false,
      "is_active": true,
      "joined_at": "2025-01-01T00:00:00Z"
    }
  ],
  "meta": { "pagination": { "page": 1, "per_page": 20, "total": 45, "total_pages": 3 } }
}
```

---

#### `POST /v1/workspaces/:workspaceId/members`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Directly creates a member record (e.g., to add a proxy/non-user member). For inviting real users, use the invite flow instead. |

**Request Body:**
```json
{
  "user_id": "uuid",
  "display_name": "Jane Doe",
  "role": "member",
  "is_proxy": false
}
```

**Response `201`:**
```json
{
  "data": { "id": "uuid", "display_name": "Jane Doe", "role": "member" }
}
```

---

#### `GET /v1/workspaces/:workspaceId/members/engagement`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns engagement metrics for all members — last active date, contribution counts, task completion rates. |

---

#### `GET /v1/workspaces/:workspaceId/members/:memberId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a single member's details. |

**Response `200`:**
```json
{
  "data": {
    "id": "uuid",
    "display_name": "Jane Doe",
    "role": "member",
    "is_proxy": false,
    "joined_at": "2025-01-01T00:00:00Z",
    "last_active_at": "2026-04-20T10:00:00Z"
  }
}
```

---

#### `PATCH /v1/workspaces/:workspaceId/members/:memberId`

| | |
|---|---|
| **Auth** | 🧑‍🤝‍🧑 Self or Admin |
| **Description** | Updates a member's display name, role, or other profile fields. A member can update their own profile; only admins can change roles. |

**Request Body:**
```json
{
  "display_name": "Jane Smith",
  "role": "admin"
}
```

**Error Cases:**
- `403 FORBIDDEN` — Non-admin attempting to change another member's profile.

---

#### `DELETE /v1/workspaces/:workspaceId/members/:memberId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Soft-deletes a member from the workspace (sets `deleted_at`). The member loses all access. |

**Response `204`:** No content.

---

#### `GET /v1/workspaces/:workspaceId/members/:memberId/profile-history`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns the audit history of changes to a member's profile. |

---

#### `GET /v1/workspaces/:workspaceId/members/:memberId/contribution-summary`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a summary of a member's contribution history across all containers they participate in. |

---

### 6.5 Invites

Kith has **two parallel invite route sets** — `/v1/invites` (legacy) and `/v1/public/invites` (current). They share the same controller. For new integrations, use the `/v1/public` prefix.

---

#### `POST /v1/workspaces/:workspaceId/invites`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates a new invite link for the workspace. |

**Request Body:**
```json
{
  "email": "newmember@example.com",
  "role": "member",
  "expires_in_days": 7
}
```

**Response `201`:**
```json
{
  "data": {
    "id": "uuid",
    "token": "abc123xyz",
    "invite_url": "https://app.kith.app/invite/abc123xyz",
    "expires_at": "2026-05-02T00:00:00Z"
  }
}
```

---

#### `GET /v1/workspaces/:workspaceId/invites`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Lists all pending (unexpired, unused) invite links for the workspace. |

---

#### `DELETE /v1/workspaces/:workspaceId/invites/:inviteId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Revokes an invite link, preventing future use. |

**Response `204`:** No content.

---

#### `GET /v1/public/invites/:token`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Description** | Returns a preview of the invite — workspace name, inviter identity, and a list of active containers. Used to render the invite landing page before the user logs in. |

**Response `200`:**
```json
{
  "data": {
    "workspace_name": "Team Alpha",
    "invited_by": "Jane Doe",
    "role": "member",
    "expires_at": "2026-05-02T00:00:00Z",
    "active_containers": [ { "name": "Monthly Pool" } ]
  }
}
```

**Error Cases:**
- `404 NOT_FOUND` — Token does not exist or has expired.

---

#### `POST /v1/public/invites/:token/accept`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Rate Limit** | 10 requests / hour / IP |
| **Description** | Accepts an invite and adds the authenticated user as a workspace member. The user must already have a profile (have called `POST /v1/auth/register`). |

**Response `200`:**
```json
{
  "data": {
    "workspace_id": "uuid",
    "workspace_name": "Team Alpha",
    "member_id": "uuid",
    "role": "member"
  }
}
```

**Error Cases:**
- `404 NOT_FOUND` — Token invalid or expired.
- `409 CONFLICT` — User is already a member of this workspace.
- `422 BUSINESS_RULE_VIOLATION` — User profile not yet registered.

**Side Effects:** Sets `used_at` on the invite link. Sends a welcome notification to the new member.

---

### 6.6 Groups

All routes are under `/v1/workspaces/:workspaceId/groups`.

---

#### `GET /v1/workspaces/:workspaceId/groups`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Lists all groups in the workspace. |

**Response `200`:**
```json
{
  "data": [
    { "id": "uuid", "name": "Executives", "member_count": 5 }
  ]
}
```

---

#### `POST /v1/workspaces/:workspaceId/groups`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates a new member group. |

**Request Body:**
```json
{
  "name": "Executives",
  "description": "C-suite members"
}
```

---

#### `GET /v1/workspaces/:workspaceId/groups/:groupId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns group details including members. |

---

#### `PATCH /v1/workspaces/:workspaceId/groups/:groupId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates group name or description. |

---

#### `DELETE /v1/workspaces/:workspaceId/groups/:groupId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Deletes the group. Does not remove the underlying members from the workspace. |

**Response `204`:** No content.

---

#### `POST /v1/workspaces/:workspaceId/groups/:groupId/members`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Adds one or more members to a group. |

**Request Body:**
```json
{
  "member_ids": ["uuid1", "uuid2"]
}
```

---

#### `DELETE /v1/workspaces/:workspaceId/groups/:groupId/members/:memberId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Removes a single member from a group. |

**Response `204`:** No content.

---

### 6.7 Containers

A "container" is a contribution pool — the central financial entity of a workspace. Containers can be one-time or recurring.

All routes are under `/v1/workspaces/:workspaceId/containers`.

---

#### `GET /v1/workspaces/:workspaceId/containers`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a paginated list of containers in the workspace. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `page` | integer | Page number |
| `per_page` | integer | Results per page |
| `status` | string | Filter by status: `active`, `completed`, `archived` |
| `type` | string | Filter by type: `one_time`, `recurring` |

---

#### `POST /v1/workspaces/:workspaceId/containers`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates a new contribution container. |

**Request Body:**
```json
{
  "name": "Monthly Savings Pool",
  "container_type": "one_time",
  "target_amount": 10000,
  "target_currency": "USD",
  "start_date": "2026-05-01",
  "end_date": "2026-12-31",
  "carry_forward_unpaid": false,
  "public_show_names": true
}
```

**Response `201`:**
```json
{
  "data": { "id": "uuid", "name": "Monthly Savings Pool", "status": "active" }
}
```

---

#### `GET /v1/workspaces/:workspaceId/containers/:containerId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns full container details. |

---

#### `PATCH /v1/workspaces/:workspaceId/containers/:containerId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates container fields (name, dates, settings). Cannot change container type after creation. |

---

#### `DELETE /v1/workspaces/:workspaceId/containers/:containerId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Soft-deletes the container. |

**Response `204`:** No content.

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/restore`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Restores a soft-deleted container. |

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/complete`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Marks a container as `completed`. All cycles are closed and no further contributions can be added. |

**Response `200`:**
```json
{
  "data": { "id": "uuid", "status": "completed" }
}
```

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/convert-to-recurring`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Converts a one-time container into a recurring container. Triggers background cycle generation. |

**Request Body:**
```json
{
  "recurrence_cadence": "monthly",
  "recurrence_start": "2026-05-01",
  "recurrence_end": "2027-05-01"
}
```

**Side Effects:** Enqueues a `cycle-generation-queue` job.

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/archive`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Archives the container. Archived containers are read-only. |

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/generate-public-link`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Generates a public share token for the container. The shared view is accessible via `GET /v1/public/containers/:publicToken`. |

**Response `200`:**
```json
{
  "data": {
    "public_token": "abc123",
    "share_url": "https://app.kith.app/share/abc123"
  }
}
```

---

#### `GET /v1/workspaces/:workspaceId/containers/:containerId/summary`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns an aggregate summary of a container — total collected, outstanding, participant count, etc. |

---

#### `GET /v1/workspaces/:workspaceId/containers/:containerId/cycles`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns all cycles for a recurring container. |

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/outcome-files/upload-url`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading an outcome document (PDF, report, etc.) for the container. |

---

#### `POST /v1/workspaces/:workspaceId/containers/:containerId/cover-photos/upload-url`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a container cover photo. |

---

#### `GET /v1/public/containers/:publicToken`

| | |
|---|---|
| **Auth** | 🔓 Public |
| **Description** | Returns a read-only summary of a container via its public share token. Member names are hidden if `public_show_names` is `false` on the container. |

**Response `200`:**
```json
{
  "data": {
    "container_name": "Monthly Savings Pool",
    "total_collected": 7500,
    "currency": "USD",
    "participant_count": 10,
    "participants": [
      { "display_name": "Jane D.", "contributed": 1000 }
    ]
  }
}
```

---

### 6.8 Participants

Participants are workspace members enrolled in a specific container.

All routes are under `/v1/workspaces/:workspaceId/containers/:containerId/participants`.

---

#### `GET .../participants`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Lists all participants in a container with their targets and contribution status. |

---

#### `POST .../participants`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Enrolls one or more workspace members as participants in the container. |

**Request Body:**
```json
{
  "member_ids": ["uuid1", "uuid2"],
  "money_enabled": true
}
```

---

#### `POST .../participants/from-group`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Enrolls all members of a workspace group as participants in the container in a single operation. |

**Request Body:**
```json
{
  "group_id": "uuid",
  "money_enabled": true
}
```

---

#### `PATCH .../participants/:participantId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates participant settings (e.g., `money_enabled` flag). |

---

#### `DELETE .../participants/:participantId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Removes a participant from the container. Does not delete their historical ledger entries. |

**Response `204`:** No content.

---

#### `POST .../participants/:participantId/set-target`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Sets or updates the contribution target for a participant. Creates a new `contributor_targets` record and marks previous targets as non-current. |

**Request Body:**
```json
{
  "target_amount": 500,
  "target_currency": "USD",
  "due_date": "2026-05-31"
}
```

---

#### `GET .../participants/:participantId/target-history`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns the full history of contribution targets set for a participant. |

---

#### `GET .../participants/:participantId/cycle-targets`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Returns per-cycle contribution targets for a participant in a recurring container. |

---

#### `POST .../cycles/:cycleId/override`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Applies an override for a specific cycle — pause the pool, skip a member, or adjust a member's target for that cycle only. |

**Request Body:**
```json
{
  "override_type": "adjust_target",
  "member_id": "uuid",
  "new_target": 750,
  "new_currency": "USD"
}
```

Valid `override_type` values: `pause_pool`, `skip_member`, `adjust_target`.

---

### 6.9 Ledger

The ledger is the core financial record of a container. Each entry represents a contribution, correction, or system-generated carry-forward.

All routes are under `/v1/workspaces/:workspaceId/containers/:containerId/ledger`.

---

#### `GET .../ledger`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a paginated list of ledger entries for the container. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `page` | integer | Page number |
| `per_page` | integer | Results per page |
| `status` | string | `pending`, `confirmed`, `disputed` |
| `contributor_id` | UUID | Filter by workspace member |
| `cycle_id` | UUID | Filter by cycle |

---

#### `POST .../ledger`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Creates a new ledger entry (contribution record). Members can create entries for themselves; admins can create entries for any participant. |

**Request Body:**
```json
{
  "contributor_id": "uuid",
  "original_amount": 500,
  "original_currency": "USD",
  "entry_type": "contribution",
  "note": "April payment",
  "cycle_id": "uuid"
}
```

**Response `201`:**
```json
{
  "data": {
    "id": "uuid",
    "status": "pending",
    "original_amount": 500,
    "original_currency": "USD"
  }
}
```

**Entry Types:** `contribution`, `correction`, `carry_forward` (carry_forward is system-generated only).

---

#### `GET .../ledger/summary`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns lightweight aggregate totals: total confirmed, total pending, outstanding balance. Must be requested **before** `GET .../ledger/:entryId` — it is a static sub-path. |

---

#### `GET .../ledger/:entryId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a single ledger entry by ID. |

---

#### `PATCH .../ledger/:entryId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Updates a ledger entry. Only `pending` entries can be edited. Admins can edit any entry; members can only edit their own. |

---

#### `DELETE .../ledger/:entryId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Deletes a `pending` or non-confirmed ledger entry. Confirmed entries cannot be deleted — raise a dispute or add a correction instead. |

**Response `204`:** No content.

---

#### `POST .../ledger/:entryId/upload-proof`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a proof file (receipt, screenshot, etc.) for a ledger entry. After upload, call `confirm-proof` to register the file. |

**Request Body:**
```json
{
  "file_name": "receipt.jpg",
  "content_type": "image/jpeg"
}
```

**Response `200`:**
```json
{
  "data": {
    "upload_url": "https://storage.supabase.co/...",
    "proof_url": "https://storage.supabase.co/proofs/uuid/receipt.jpg"
  }
}
```

---

#### `POST .../ledger/:entryId/confirm-proof`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Registers an uploaded proof file against the ledger entry. |

**Request Body:**
```json
{
  "proof_url": "https://storage.supabase.co/proofs/uuid/receipt.jpg"
}
```

---

#### `GET .../ledger/:entryId/proof-url`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a signed read URL for downloading the proof file attached to a ledger entry. |

---

#### `DELETE .../ledger/:entryId/proof/:proofIndex`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Removes a proof file from a ledger entry by its array index. |

**Path Parameters:**
- `proofIndex` — Zero-based index of the proof file in the entry's proof array.

**Response `204`:** No content.

---

#### `POST .../ledger/:entryId/confirm`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Admin confirms a pending ledger entry. Sets `status = confirmed`, records `confirmed_by` and `confirmed_at`. |

**Response `200`:**
```json
{
  "data": { "id": "uuid", "status": "confirmed", "confirmed_at": "2026-04-25T..." }
}
```

---

#### `POST .../ledger/:entryId/add-correction`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Adds a correction record linked to an existing ledger entry. Used to amend a confirmed entry without deleting it (audit-safe). |

**Request Body:**
```json
{
  "correction_amount": -100,
  "correction_currency": "USD",
  "note": "Duplicate payment refund"
}
```

---

#### `POST .../ledger/:entryId/dispute`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Raises a dispute against a ledger entry. Transitions the entry to `disputed` status. |

**Request Body:**
```json
{
  "reason": "This amount is incorrect — I paid $600, not $500."
}
```

---

#### `GET /v1/workspaces/:workspaceId/ledger/export`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Exports all ledger entries for the workspace (across all containers) as a downloadable file. |

---

### 6.10 Disputes

Disputes are formal objections to ledger entries.

All routes are under `/v1/workspaces/:workspaceId/disputes`.

---

#### `GET /v1/workspaces/:workspaceId/disputes`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Lists all disputes in the workspace with their current status. |

---

#### `GET .../disputes/:disputeId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a single dispute with its notes and resolution history. |

---

#### `POST .../disputes/:disputeId/note`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Adds a comment/note to a dispute (visible to both the member and admins). |

**Request Body:**
```json
{
  "note": "I have attached the correct receipt."
}
```

---

#### `POST .../disputes/:disputeId/resolve`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Resolves a dispute. The admin provides a resolution and optionally corrects the ledger entry. |

**Request Body:**
```json
{
  "resolution": "upheld",
  "resolution_note": "Confirmed payment of $600. Correcting entry.",
  "corrected_amount": 600
}
```

Valid `resolution` values: `upheld`, `rejected`.

---

### 6.11 Tasks

Tasks are action items within a container, assignable to participants.

All routes are under `/v1/workspaces/:workspaceId/containers/:containerId/tasks`.

---

#### `GET .../tasks`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a paginated list of tasks in the container. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `status` | string | `pending`, `completed`, `overdue` |
| `assigned_to` | UUID | Filter by assignee |
| `page` | integer | Page number |
| `per_page` | integer | Results per page |

---

#### `POST .../tasks`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates a single task and assigns it to a participant. |

**Request Body:**
```json
{
  "title": "Submit Q1 report",
  "description": "Upload the Q1 financial summary PDF.",
  "assigned_to": "uuid",
  "due_date": "2026-05-15",
  "requires_proof": true
}
```

---

#### `POST .../tasks/bulk`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates multiple tasks in a single request. |

**Request Body:**
```json
{
  "tasks": [
    { "title": "Task A", "assigned_to": "uuid1", "due_date": "2026-05-01" },
    { "title": "Task B", "assigned_to": "uuid2", "due_date": "2026-05-15" }
  ]
}
```

---

#### `GET .../tasks/export`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Exports all tasks for the container as a downloadable file. |

---

#### `GET .../tasks/:taskId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a single task with its details and proof files. |

---

#### `PATCH .../tasks/:taskId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Updates a task. Members can update their own assigned tasks (e.g., mark complete). Admins can update any task. |

---

#### `DELETE .../tasks/:taskId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Soft-deletes a task. |

**Response `204`:** No content.

---

#### `PATCH .../tasks/:taskId/reassign`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Reassigns a task to a different participant. |

**Request Body:**
```json
{
  "assigned_to": "uuid"
}
```

---

#### `PATCH .../tasks/:taskId/status`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Hard override for a task's status. This is an admin-only operation that bypasses normal status transition rules. |

**Request Body:**
```json
{
  "status": "completed"
}
```

---

#### `POST .../tasks/:taskId/confirm`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Admin confirms a task as completed. Used when `requires_proof` tasks need admin sign-off. |

---

#### `POST .../tasks/:taskId/upload-proof`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a task completion proof file. |

---

#### `POST .../tasks/:taskId/confirm-proof`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Registers an uploaded proof file against a task. |

---

#### `DELETE .../tasks/:taskId/proof/:proofIndex`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Removes a proof file from a task by zero-based index. |

**Response `204`:** No content.

---

### 6.12 Milestones & Timeline

Milestones are workspace-level events visible on the workspace timeline.

---

#### `GET /v1/workspaces/:workspaceId/timeline`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns all milestones for the workspace in chronological order. |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Project Kickoff",
      "date": "2026-01-15",
      "photos": [ "https://..." ]
    }
  ]
}
```

---

#### `POST /v1/workspaces/:workspaceId/milestones`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Creates a milestone on the workspace timeline. |

**Request Body:**
```json
{
  "title": "First Contribution Collected",
  "description": "We hit our first milestone!",
  "date": "2026-04-01"
}
```

---

#### `GET .../milestones/:milestoneId`

| | |
|---|---|
| **Auth** | 🔒 Authenticated + Member |
| **Description** | Returns a single milestone with its photos. |

---

#### `PATCH .../milestones/:milestoneId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Updates a milestone's title, description, or date. |

---

#### `DELETE .../milestones/:milestoneId`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Deletes a milestone. |

**Response `204`:** No content.

---

#### `POST .../milestones/:milestoneId/photos/upload-url`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Rate Limit** | 20 requests / hour / IP |
| **Description** | Returns a pre-signed URL for uploading a photo to attach to a milestone. |

---

#### `POST .../milestones/:milestoneId/photos/confirm`

| | |
|---|---|
| **Auth** | 👑 Admin |
| **Description** | Registers an uploaded photo against a milestone. |

---

### 6.13 Notifications

Notifications are user-scoped (tied to a `workspace_members.id` as `recipient_id`), not workspace-scoped. They are mounted at `/v1/notifications`.

---

#### `GET /v1/notifications/count`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Returns the unread notification count for the current user. Lightweight — intended for badge polling. Optionally scoped to a specific workspace via query parameter. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `workspace_id` | UUID | (optional) Scope count to a specific workspace |

**Response `200`:**
```json
{
  "data": { "unread_count": 5 }
}
```

---

#### `GET /v1/notifications`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Returns a paginated list of notifications for the current user. |

**Query Parameters:**
| Param | Type | Description |
|---|---|---|
| `page` | integer | Page number |
| `per_page` | integer | Results per page |
| `workspace_id` | UUID | Scope to a specific workspace |
| `unread_only` | boolean | If `true`, returns only unread notifications |

**Response `200`:**
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "payment_reminder",
      "title": "Contribution Due Soon",
      "body": "Your contribution of $500 USD is due by 2026-04-30.",
      "is_read": false,
      "created_at": "2026-04-23T08:00:00Z",
      "reference_type": "container",
      "reference_id": "uuid"
    }
  ],
  "meta": { "pagination": { ... } }
}
```

**Notification Types:**
- `payment_reminder` — Contribution due within 7 days.
- `overdue_reminder` — Contribution is past due.
- `cycle_started` — A new cycle has opened in a recurring container.
- `task_overdue` — A task has passed its due date.
- `admin_announcement` — Admin broadcast message.
- `welcome` — Sent on invite acceptance.

---

#### `PATCH /v1/notifications/read-all`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Marks all notifications as read for the current user. |

**Response `200`:**
```json
{
  "data": { "updated_count": 5 }
}
```

---

#### `PATCH /v1/notifications/:notificationId/read`

| | |
|---|---|
| **Auth** | 🔒 Authenticated |
| **Description** | Marks a single notification as read. |

**Response `200`:**
```json
{
  "data": { "id": "uuid", "is_read": true }
}
```

---

### 6.14 Public Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/public/invites/:token` | Preview invite (documented in §6.5) |
| `POST` | `/v1/public/invites/:token/accept` | Accept invite (documented in §6.5) |
| `GET` | `/v1/public/containers/:publicToken` | Shared container view (documented in §6.7) |

---

## 7. Pagination, Filtering & Sorting

### Pagination

All list endpoints that return collections support pagination via query parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | integer | `1` | The page number to retrieve. |
| `per_page` | integer | `20` | Number of records per page. |

Paginated responses include a `meta.pagination` object:

```json
{
  "meta": {
    "pagination": {
      "page": 2,
      "per_page": 20,
      "total": 143,
      "total_pages": 8
    }
  }
}
```

### Filtering

Filtering is endpoint-specific. Common filter parameters across list endpoints:

- `status` — Filter by record status.
- `role` — Filter members by role.
- `q` — Full-text search query.
- `from` / `to` — Date range filters (ISO 8601 format).

### Sorting

Sorting behavior is determined server-side per entity. No generic sort query parameter is exposed in the current API. The sort order for each collection is documented inline in each endpoint's description.

---

## 8. File Uploads

Kith uses a **two-step upload pattern** for all file uploads. Files are never sent through the Kith API server — they go directly to Supabase Storage.

### Upload Flow

```
1. Call the relevant "upload-url" endpoint to get a pre-signed PUT URL.
2. Upload the file directly to that URL using HTTP PUT.
3. Call the corresponding "confirm" endpoint to register the file in the database.
```

### Endpoints That Use This Pattern

| Resource | Get URL Endpoint | Confirm Endpoint |
|---|---|---|
| User avatar | `POST /v1/auth/avatar/upload-url` | `PATCH /v1/auth/profile` (pass `avatar_url`) |
| Workspace avatar | `POST /v1/workspaces/:id/avatar-upload-url` | `PATCH /v1/workspaces/:id` |
| Ledger proof | `POST .../ledger/:entryId/upload-proof` | `POST .../ledger/:entryId/confirm-proof` |
| Task proof | `POST .../tasks/:taskId/upload-proof` | `POST .../tasks/:taskId/confirm-proof` |
| Container outcome file | `POST .../outcome-files/upload-url` | *(registers automatically)* |
| Container cover photo | `POST .../cover-photos/upload-url` | *(registers automatically)* |
| Milestone photo | `POST .../milestones/:id/photos/upload-url` | `POST .../milestones/:id/photos/confirm` |

### Upload Constraints

- **Rate Limit:** 20 upload URL requests per hour per IP.
- **Content-Type:** Must be specified in the upload URL request and matched when performing the PUT.
- Pre-signed URLs are time-limited (Supabase default: 60 seconds).

### Example: Upload a Ledger Proof

```http
# Step 1 — Get pre-signed URL
POST /v1/workspaces/uuid/containers/uuid/ledger/uuid/upload-proof
Authorization: Bearer <token>
Content-Type: application/json

{ "file_name": "receipt.jpg", "content_type": "image/jpeg" }

# → { "data": { "upload_url": "https://...", "proof_url": "https://..." } }

# Step 2 — Upload directly to storage
PUT https://<upload_url>
Content-Type: image/jpeg
<binary file body>

# Step 3 — Confirm the proof
POST /v1/workspaces/uuid/containers/uuid/ledger/uuid/confirm-proof
Authorization: Bearer <token>
Content-Type: application/json

{ "proof_url": "https://..." }
```

---

## 9. Background Jobs & Async Behavior

Kith uses **BullMQ** (backed by Redis) for all background processing. Jobs are managed through named queues.

### Queue Overview

| Queue Name | Worker | Trigger | Cadence |
|---|---|---|---|
| `reminder-queue` | `createReminderWorker` | Scheduled | Daily |
| `cycle-generation-queue` | `createCycleGenerationWorker` | Container conversion / cycle close | On-demand |
| `cycle-lifecycle-queue` | `createCycleLifecycleWorker` | Scheduled | Daily |
| `task-overdue-queue` | `createTaskOverdueWorker` | Scheduled | Daily |
| `invite-cleanup-queue` | `createInviteCleanupWorker` | Scheduled | Periodic |
| `engagement-check-queue` | `createEngagementCheckWorker` | Scheduled | Periodic |
| `notification-queue` | *(notification delivery worker)* | Every notification send | On-demand |
| `notification-outbox-queue` | `createNotificationOutboxWorker` | Scheduled | Every 5 minutes |

### Job Descriptions

**Reminder Worker** — Scans `contributor_targets` for contributions due within 7 days and sends `payment_reminder` notifications. Also sends `overdue_reminder` for past-due targets. Deduplication via `dedupKey` prevents double-sending within the same day.

**Cycle Generation Worker** — For recurring containers, generates upcoming `container_cycles` up to 3 months ahead. Per-cycle `contributor_targets` are upserted for each participant using pre-fetched override maps (pause, skip, adjust). Triggered when a container is converted to recurring or when a cycle closes.

**Cycle Lifecycle Worker** — Transitions `upcoming` cycles to `open` when their `cycle_start` date arrives. Closes `open` cycles past `cycle_end`. If `carry_forward_unpaid` is enabled, inserts system-generated `carry_forward` ledger entries for outstanding balances into the next cycle. Re-enqueues cycle generation after each close.

**Task Overdue Worker** — Updates `pending` tasks with past `due_date` to `overdue` status and sends `task_overdue` notifications to the assignee and all workspace admins.

**Invite Cleanup Worker** — Hard-deletes expired (`expires_at < now`), unused (`used_at IS NULL`) invite links.

**Engagement Check Worker** — Updates `workspace_members.last_active_at` using the most recent confirmed ledger entry or completed task timestamp per member. Uses 3 total DB queries regardless of member count.

**Notification Outbox Worker** — Safety net that re-enqueues `pending` or `failed` non-in-app notification deliveries older than 5 minutes. Ensures no notification is silently dropped if a `queue.add` call failed.

### Endpoints That Trigger Async Jobs

| Endpoint | Job Triggered |
|---|---|
| `POST .../containers/:id/convert-to-recurring` | `cycle-generation-queue` |
| `POST /v1/auth/data-export` | Data export job (emailed to user) |
| Cycle close (automatic) | `cycle-generation-queue` |

### Admin Queue Monitor

The BullMQ queue dashboard is accessible at `/admin/queues` when `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD` environment variables are set. Access requires:

1. IP must be in `ADMIN_IP_WHITELIST`.
2. HTTP Basic Auth credentials matching the environment variables.

---

## 10. Real-Time / Events

The current API does **not** expose WebSocket or Server-Sent Events endpoints. Real-time behavior is implemented via:

**Client-Side Polling**
- `GET /v1/notifications/count` — Intended for lightweight badge polling. Clients should poll this endpoint periodically (e.g., every 30–60 seconds) to check for new notifications.

**Push Notifications (Firebase FCM)**
- When a background worker sends a notification via the `notification-queue`, the notification delivery worker dispatches a push message to the user's registered FCM token (stored via `POST /v1/auth/push-token`).
- Supported platforms: `ios`, `android`.
- Proxy members (`is_proxy = true`) never receive push notifications.

**Email Digest**
- Users with `email_digest_enabled = true` receive email summaries of their notifications.

---

## 11. Data Consistency & Constraints

### Rules Frontend Must Respect

- **All IDs are UUIDs.** Never construct or guess IDs. Always use IDs returned by the API.
- **Ledger entries can only be deleted when `status = pending`.** Do not offer delete UI for confirmed entries.
- **Container type (`container_type`) is immutable after creation** unless `convert-to-recurring` is called.
- **Proof arrays are indexed from zero.** The `proofIndex` in delete-proof endpoints is the zero-based position in the array.
- **Invite tokens expire.** Always check `expires_at` before presenting an invite acceptance UI.
- **`carry_forward` entries are system-generated.** They are created automatically when a cycle closes with `carry_forward_unpaid = true`. Do not attempt to create them manually.

### Soft Deletes

All major entities (`users`, `workspace_members`, `containers`, `container_tasks`, `invite_links`) use `deleted_at` for soft deletion. Queries always filter `deleted_at IS NULL`. Deleted records are invisible to all API consumers.

### Anti-Enumeration Design

Workspace membership failures return `404 NOT_FOUND`, not `403 FORBIDDEN`. This prevents an attacker from determining valid workspace IDs by probing the API.

### Unique Violations

Postgres unique violations (error code `23505`) are caught globally and returned as `409 CONFLICT` with `"code": "CONFLICT"`. No raw database errors are ever exposed.

---

## 12. Security Considerations

### Authentication

- Tokens are validated server-side via Supabase Admin SDK on every request. No local JWT decoding.
- The `requireAuth` middleware rejects any request with a missing, malformed, or expired token before it reaches a controller.
- `last_seen_at` is updated fire-and-forget on every authenticated request, without blocking the response.

### Authorization

- Workspace isolation is enforced by `requireMembership` middleware — not by trusting request body parameters.
- Role enforcement (`requireAdmin`, `requireSelfOrAdmin`) happens at the route layer, not inside controllers, making the security model auditable from the route file alone.

### Rate Limiting

| Scope | Limit |
|---|---|
| General API | 200 requests / minute / IP |
| Auth endpoints | 5 requests / minute / IP |
| Invite acceptance | 10 requests / hour / IP |
| File upload URL generation | 20 requests / hour / IP |

Rate limiting uses an **in-memory store** (not Redis-backed). This means limits are **per-instance** in a multi-replica deployment — teams operating multiple API instances should swap to a Redis store for consistent rate limiting.

### CORS

Only the origin defined by `FRONTEND_URL` is permitted. Credentials are allowed. Allowed headers: `Content-Type`, `Authorization`, `X-Request-Id`.

### Admin Queue Monitor

The `/admin/queues` route is protected by IP allowlist (`ADMIN_IP_WHITELIST`) and HTTP Basic Auth. It is only activated when both `BULL_BOARD_USERNAME` and `BULL_BOARD_PASSWORD` are set.

### Data Exposure

- In production, unhandled error messages are redacted — the client receives `"An internal error occurred"` instead of the raw error message.
- The `forgot-password` endpoint is always success — it never reveals whether an email is registered.
- The `requireMembership` guard returns `404` (not `403`) to prevent workspace ID enumeration.

---

## 13. Common Workflows

### Workflow 1: User Signup → Onboarding → Workspace Creation

```
1. POST /v1/auth/signup          { email, password }
   → Supabase sends verification email

2. (User clicks email link)

3. POST /v1/auth/verify-email    { token_hash, type: "email" }
   → Returns { access_token, refresh_token }

4. POST /v1/auth/register        { full_name, timezone }
   → Creates/upserts users row

5. POST /v1/workspaces           { name, base_currency }
   → Creates workspace; caller becomes admin

6. GET  /v1/auth/me
   → Returns user + workspace memberships
```

---

### Workflow 2: Inviting a Member → Member Acceptance

```
[Admin]
1. POST /v1/workspaces/:id/invites   { email, role: "member", expires_in_days: 7 }
   → Returns { token, invite_url }

2. Admin shares invite_url with the invitee.

[Invitee — before logging in]
3. GET /v1/public/invites/:token
   → Preview: workspace name, inviter, active containers

[Invitee — must be logged in]
4. POST /v1/public/invites/:token/accept
   → User becomes a workspace member
   → Welcome notification sent

[Admin — optional cleanup]
5. GET  /v1/workspaces/:id/invites         → Verify the invite is now used
6. DELETE /v1/workspaces/:id/invites/:id   → Revoke unused invite links
```

---

### Workflow 3: Contribution Lifecycle (Member Submits → Admin Confirms)

```
[Member]
1. POST .../ledger                            { contributor_id, original_amount, entry_type: "contribution" }
   → Entry created with status: "pending"

2. POST .../ledger/:entryId/upload-proof      { file_name, content_type }
   → Returns { upload_url, proof_url }

3. PUT <upload_url> (binary file)

4. POST .../ledger/:entryId/confirm-proof     { proof_url }
   → Proof registered on entry

[Admin]
5. GET  .../ledger                            → Review pending entries

6. POST .../ledger/:entryId/confirm
   → status → "confirmed", confirmed_at set

   OR

   [Member or Admin]
   POST .../ledger/:entryId/dispute          { reason }
   → status → "disputed"
```

---

### Workflow 4: Dispute Resolution

```
[Member]
1. POST .../ledger/:entryId/dispute        { reason }
   → Dispute created; entry status → "disputed"

2. POST .../disputes/:disputeId/note       { note }
   → Member adds supporting comment

[Admin]
3. GET  /v1/workspaces/:id/disputes        → Review open disputes

4. POST .../disputes/:disputeId/resolve    { resolution: "upheld", corrected_amount: 600 }
   → Dispute closed; correction applied if applicable
```

---

### Workflow 5: Recurring Container Lifecycle

```
[Admin]
1. POST /v1/workspaces/:id/containers      { container_type: "recurring", recurrence_cadence: "monthly", ... }
   → Container created; cycle generation triggered in background

   OR convert existing:
   POST .../containers/:id/convert-to-recurring
   → Triggers cycle-generation-queue job

2. POST .../participants                   { member_ids: [...] }
3. POST .../participants/:id/set-target    { target_amount, target_currency, due_date }

[Background — daily]
4. cycle-lifecycle-queue worker:
   - Opens upcoming cycles whose start date has arrived
   - Notifies participants with their individual targets
   - Closes past-end cycles
   - Carry-forwards unpaid balances if enabled
   - Triggers cycle generation for next 3 months

[Admin — optional per-cycle overrides]
5. POST .../cycles/:cycleId/override       { override_type: "skip_member", member_id: "uuid" }
```

---

### Workflow 6: Task Assignment and Completion

```
[Admin]
1. POST .../tasks                          { title, assigned_to, due_date, requires_proof: true }

[Member]
2. POST .../tasks/:taskId/upload-proof     { file_name, content_type }
   → Returns pre-signed upload URL

3. PUT <upload_url> (binary file)

4. POST .../tasks/:taskId/confirm-proof   { proof_url }

[Admin]
5. POST .../tasks/:taskId/confirm          → Marks task as completed

[Background — daily]
6. task-overdue-queue:
   → Marks past-due pending tasks as "overdue"
   → Notifies assignee + all admins
```

---

## 14. Missing / Weak Endpoints

The following gaps and design weaknesses were identified by analysis of the actual codebase. No code has been modified.

### Missing Endpoints

**1. No `GET /v1/workspaces/:id/containers/:id/participants/:id` (single participant fetch)**
There is no endpoint to fetch a single participant's details directly. Clients must call `listParticipants` and filter client-side, which is inefficient for large containers.

**2. No cycle-level ledger entry filter without full list**
There is no dedicated `GET .../cycles/:cycleId/ledger` endpoint. Clients must call `GET .../ledger?cycle_id=uuid`, which works, but is not surfaced as a first-class cycle view.

**3. No `PATCH /v1/workspaces/:id/containers/:id/ledger/:entryId/dispute` to update a dispute reason**
Once raised, a dispute's initial reason cannot be edited by the member. Only notes can be added.

**4. No `GET /v1/workspaces/:id/containers/:id/ledger/:entryId/corrections` list**
Corrections are added via `add-correction` but there is no endpoint to list all corrections for an entry.

**5. No `DELETE /v1/workspaces/:id/avatar` or `DELETE /v1/auth/avatar`**
Users and workspace admins can upload avatars but cannot remove them (revert to null).

**6. No endpoint to list or revoke push tokens**
`POST /v1/auth/push-token` registers a token, but there is no `GET` or `DELETE` to inspect or revoke device tokens. This complicates multi-device management.

**7. No `GET /v1/workspaces/:id/groups/:id/members` (member list for a group)**
`GET .../groups/:groupId` is admin-only, so regular members cannot inspect group composition. There is no member-accessible group member list.

**8. No endpoint for bulk dispute listing across workspaces**
Disputes are listed per-workspace, so a super-admin view across all workspaces is not supported.

### Weak API Designs

**1. Rate Limiter uses in-memory store**
The rate limiter (`rateLimiter.js`) explicitly comments that it uses the default memory store, not Redis. In a horizontally scaled deployment (multiple API instances), each instance has its own rate limit counter, effectively multiplying the allowed request rate by the number of replicas. This should be migrated to `rate-limit-redis` or a similar distributed store.

**2. Dual invite route sets (`/v1/invites` and `/v1/public/invites`)**
Two route files expose the same invite controller actions. The `/v1/invites` set is explicitly marked as "legacy" in `app.js`. However, there is no deprecation header, no sunset date, and the routes remain fully active. Without a migration plan, clients may continue using the legacy routes indefinitely.

**3. Notification resolution is fragile for multi-workspace users**
The `resolveMember` middleware in `notification.routes.js` resolves a user's member ID by selecting the most recently joined active membership. If a user is a member of multiple workspaces and does not provide `?workspace_id=`, notifications from the "wrong" workspace may surface. The `workspace_id` parameter should be required, not optional.

**4. No idempotency key support on ledger entry creation**
`POST .../ledger` has no idempotency mechanism. A network retry from the client will create a duplicate pending entry. This is a real risk in mobile environments.

**5. `convert-to-recurring` has no validation of existing cycles**
If a container already has ledger entries or participants, converting it to recurring may create unexpected data states. The API does not document whether this conversion is safe on non-empty containers.

**6. Audit log export format is not documented**
`GET .../audit-log/export` exists but the output format (CSV, JSON, XLSX) and schema are not exposed in the route definition or available controller metadata.

**7. No `PATCH /v1/workspaces/:id/containers/:id/ledger/:id/dispute` to withdraw a dispute**
A member who raised a dispute by mistake has no API method to withdraw it. Only an admin can resolve it.

---

## 15. API Quality Assessment

### Overall Rating: **Strong**

---

### Evaluation by Dimension

| Dimension | Rating | Notes |
|---|---|---|
| **Consistency** | ⭐⭐⭐⭐☆ | Response envelope (`{ data }`, `{ error }`) is uniform throughout. Route naming follows REST conventions well. Two legacy invite routes introduce minor inconsistency. |
| **Developer Experience** | ⭐⭐⭐⭐☆ | Error codes are structured and machine-readable. The two-step upload pattern is correct. Pagination is standardized. The lack of an OpenAPI/Swagger spec is the main gap. |
| **Security** | ⭐⭐⭐⭐⭐ | Auth is server-verified (not local-decode). Role middleware applied at route layer, not controller. Anti-enumeration on workspace access. Forgot-password never reveals email existence. Rate limiting present on all sensitive endpoints. |
| **Scalability Readiness** | ⭐⭐⭐☆☆ | Background workers use efficient batch queries (O(3) instead of O(2N)). Rate limiter uses in-memory store — will not scale horizontally without Redis store migration. No idempotency keys on critical write endpoints. |
| **Observability** | ⭐⭐⭐⭐⭐ | Every request gets a UUID `X-Request-Id` propagated through logs. Winston structured logging with request metadata. Sentry integration for error tracking. BullMQ board for queue monitoring. |
| **Business Logic Completeness** | ⭐⭐⭐⭐☆ | Carry-forward unpaid, cycle overrides (pause/skip/adjust), dispute flow, proxy members, GDPR export — all sophisticated and correctly implemented. Missing: single participant fetch, dispute withdrawal, push token management. |
| **Data Integrity** | ⭐⭐⭐⭐⭐ | Soft deletes everywhere. Postgres constraint errors caught globally. Background outbox worker retries failed notification deliveries. Deduplication on reminder notifications via `dedupKey`. |

---

### What Distinguishes This API

1. **The authorization layering is clean.** Security decisions are made at the Express route level, not scattered through controller logic, making the system auditable at a glance.

2. **Background worker design is production-grade.** The engagement check worker and cycle generation worker use pre-fetched lookup maps to reduce database queries from O(N) to O(1) within loops — a pattern typical of senior backend engineering.

3. **The notification pipeline has a reliability safety net.** The outbox worker re-enqueues stale failed deliveries, closing the gap where a queue insertion failure would silently drop a notification.

4. **Anti-enumeration is applied consistently.** Returning `404` instead of `403` for non-member workspace access is a correct security pattern that many APIs miss.

---

### Priority Improvements

| Priority | Action |
|---|---|
| P0 | Migrate rate limiter to Redis store for multi-instance deployments |
| P0 | Add idempotency key support to `POST .../ledger` |
| P1 | Deprecate and sunset `/v1/invites` legacy routes with `Sunset` + `Deprecation` headers |
| P1 | Make `?workspace_id` required on notification routes |
| P1 | Add `GET .../participants/:participantId` single participant endpoint |
| P2 | Publish OpenAPI 3.1 spec auto-generated from route definitions |
| P2 | Add `DELETE /v1/auth/push-token/:tokenId` for device token management |
| P2 | Add dispute withdrawal endpoint for members |
