# ADR-0004: Supabase as Combined Data, Auth, and Storage Provider

**Status:** Accepted

## Context

The application needs three infrastructure primitives: a relational
database (workspaces, members, containers, ledger entries, tasks,
disputes, milestones — a genuinely relational domain with foreign keys and
transactional requirements), a user-authentication system (signup, login,
password reset, OAuth), and file storage (proof-of-payment images, task
proofs, milestone photos, avatars, exported CSVs referenced by URL).

## Problem Statement

Should the database, authentication, and file storage be three separately
selected and integrated services (e.g. Postgres + a dedicated auth
provider + S3), or one combined platform?

## Decision

Use Supabase for all three: Postgres as the relational store (accessed
through `@supabase/supabase-js`'s query builder, not raw SQL, except where
Postgres RPCs are explicitly needed — see ADR-0010), Supabase Auth for
signup/login/password-reset/Google OAuth/session issuance, and Supabase
Storage for all file uploads (`storage.service.js`'s `BUCKET` constant,
signed upload/download URLs).

`config/database.js` is a minimal shim that exists only to provide
`checkConnection()` for server startup health checks. All real database
operations happen directly via `supabaseAdmin.from()` in each
controller/service — there is no separate `query()` abstraction layer.

## Alternatives Considered

- **Raw Postgres (`pg` driver) + a separate auth provider (e.g. Auth0,
  Firebase Auth) + S3-compatible storage.** Rejected in favor of
  consolidation — a single combined platform removes the need to
  separately provision and wire three different providers with three
  different credential and retry models.
- **Firebase for auth/storage, Postgres for data.** Partially adopted in
  practice — Firebase Admin SDK (`config/firebase.js`) is present, but
  scoped narrowly to push notification delivery (FCM) only, not general
  auth or storage. This is a targeted, single-purpose integration
  alongside Supabase, not a replacement for it.

## Rationale

- **One service-role client, one connection story.** `supabaseAdmin` in
  `config/supabase.js` is the single object threaded through every service
  file for both data and storage access, and `supabaseAuth` (anon key)
  handles user-facing auth flows. This means one set of credentials, one
  client library, and one set of network/retry semantics to reason about
  for the overwhelming majority of the codebase's I/O.
- **Row-level security potential.** Splitting `supabaseAdmin` (bypasses
  RLS, service-role key) from `supabaseAuth` (respects RLS, anon key) —
  see ADR-0005 — is only straightforward because both clients talk to the
  same Supabase project; a separately-hosted Postgres instance would need
  its own authorization layer built from scratch rather than leaning on
  Postgres RLS.
- **Signed URLs for storage.** `storage.service.js`'s
  `createSignedUploadUrl`/`createSignedUrl` calls let clients upload/
  download files directly against Supabase Storage without proxying bytes
  through the API server — this pattern is available specifically because
  storage and the API share a provider and a service-role credential.

## Trade-offs

- **Vendor lock-in.** Postgres RPCs (ADR-0010), Supabase Auth's specific
  session/JWT shape (`amr` claims used for recovery-session detection in
  `auth.service.js`), and Supabase Storage's signed-URL API are all
  Supabase-specific surfaces threaded deeply through the service layer.
  Migrating off Supabase would touch nearly every service file.
- **Health check depends on data-plane availability, not a dedicated
  liveness endpoint.** `database.js#checkConnection` issues a real `SELECT`
  against the `users` table to verify connectivity — simple, but couples
  the app's own `/health` endpoint to query latency/RLS behavior on a real
  table rather than a lightweight ping.

## Consequences

- New engineers only need to learn one client library's query builder
  (`supabaseAdmin.from(...).select()/.insert()/.update()/.delete()`) to
  work across the entire data layer, rather than switching mental models
  between an ORM, a separate auth SDK, and an S3 SDK.
- Postgres-specific error codes are handled centrally in
  `errorHandler.js` (`23505` unique violation → 409, `23503` FK violation
  → 422) with no need for an abstraction layer translating between
  different providers' error shapes.
- Capabilities Supabase doesn't offer natively (push notification
  delivery) are handled by adding a second, narrowly-scoped provider
  (Firebase Admin SDK, used solely for FCM) rather than working around the
  gap inside Supabase.

## Related Files

- `src/config/supabase.js`
- `src/config/database.js`
- `src/config/firebase.js` (narrow exception: push notifications only)
- `src/services/storage.service.js`
- `src/services/auth.service.js`
