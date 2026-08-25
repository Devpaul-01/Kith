# ADR-0005: Dual Supabase Client — Service-Role vs. Anon Key

**Status:** Accepted

## Context

`config/supabase.js` instantiates two distinct Supabase clients from two
distinct keys:

```js
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, { ... }); // bypasses RLS
const supabaseAuth  = anonKey ? createClient(supabaseUrl, anonKey, { ... }) : null; // respects RLS
```

`supabaseAdmin` is the service-role (admin) client and bypasses Row-Level
Security entirely — it is never exposed to clients. `supabaseAuth` is the
anon client, safe for user-facing auth operations (`signIn`, `signUp`,
`resetPassword`).

## Problem Statement

The application's own middleware (`middleware/auth.js`,
`middleware/workspace.js`) already performs authorization decisions in
JavaScript before every data access — so why maintain a second Supabase
client at all, instead of doing everything through one service-role
client?

## Decision

Maintain two clients with two different responsibilities:

- **`supabaseAdmin`** (service-role key) is used for essentially all data
  reads/writes across every service file — it is the client threaded
  through `services/*.service.js` for workspaces, members, containers,
  ledger entries, etc. Authorization for these is enforced explicitly in
  application code (`requireAuth`, `requireMembership`, `requireAdmin`,
  per-service `isAdmin`/`callerId` checks), not by Postgres RLS.
- **`supabaseAuth`** (anon key) is used exclusively for Supabase Auth
  operations that must go through Supabase's own auth flow rather than a
  direct table write: `signUp`, `signInWithPassword`, `resetPasswordForEmail`,
  `refreshSession`, `exchangeCodeForSession`, `verifyOtp`. `getAuthClient()`
  in `auth.service.js` throws a `503 SERVICE_UNAVAILABLE` `AppError` if
  `SUPABASE_ANON_KEY` isn't configured, since these specific operations
  have no `supabaseAdmin` equivalent.

`changePassword` in `auth.service.js` is a clear example of why both
clients are needed in a single flow: it calls `supabaseAuth.auth.
signInWithPassword` first to *verify* the caller's current password — an
attacker holding a stolen access token but not the account password cannot
use this endpoint to lock the real owner out — then calls
`supabaseAdmin.auth.admin.updateUserById` to actually perform the
privileged password change.

## Alternatives Considered

- **Use only `supabaseAdmin` everywhere, including for login/signup.**
  Rejected — Supabase Auth operations like `signInWithPassword` are
  fundamentally anon-key operations in Supabase's model (they represent a
  user proving their own identity, not an admin acting on their behalf).
  Attempting these through the admin client would sidestep Supabase's own
  auth verification rather than use it.
- **Use only `supabaseAuth` and rely on RLS for all authorization.**
  Rejected — the codebase's authorization model is entirely hand-rolled in
  middleware (`requireMembership`, `requireAdmin`, `requireSelfOrAdmin`)
  and per-service checks (`isAdmin`, `contributor_id !== callerId`
  comparisons throughout `ledger.service.js`, `task.service.js`, etc.), not
  RLS policies. Switching to RLS-based authorization would mean re-deriving
  all of this logic as Postgres policies, a substantial undertaking with
  no corresponding benefit given the application-layer model already in
  place.

## Rationale

Splitting the two clients cleanly separates "operations that must be
authenticated as the end user" (auth flows) from "operations that the
already-authenticated-and-authorized request needs the backend to perform
on the user's behalf" (everything else). Because `requireAuth` already
independently verifies the caller's JWT via `supabaseAdmin.auth.getUser
(token)` before any `supabaseAdmin` data call happens, using the admin
client for data access is a considered choice — the authorization gate
already happened in middleware.

## Trade-offs

- The service-role key, if leaked, bypasses all RLS and all
  application-level authorization simultaneously — there is no
  defense-in-depth from Postgres itself if `requireAuth`/`requireMembership`/
  `requireAdmin` were ever bypassed by an application bug, since RLS isn't
  independently enforcing anything on the tables these services touch.
- Two clients means two credentials to manage and rotate, and
  `supabaseAuth` being `null` when `SUPABASE_ANON_KEY` is unset is a
  runtime condition every auth-flow function must account for (via
  `getAuthClient()`'s explicit check) rather than a build-time guarantee.

## Consequences

- Authorization logic is fully visible and greppable in application code
  (middleware + service-level checks) rather than split between
  application code and Postgres RLS policies — a single source of truth,
  at the cost of RLS providing no independent backstop.
- Any new auth-adjacent feature (e.g. magic-link login) has an obvious
  home: `supabaseAuth`, following the same pattern as the six existing auth
  operations.

## Related Files

- `src/config/supabase.js`
- `src/services/auth.service.js` (`getAuthClient`, `changePassword`,
  `mapSupabaseAuthError`)
- `src/middleware/auth.js` (`requireAuth` — the gate that makes
  admin-client data access safe)
