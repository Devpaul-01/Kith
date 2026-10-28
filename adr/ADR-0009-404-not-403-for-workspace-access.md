# ADR-0009: 404-Not-403 for Unauthorized Workspace Access

**Status:** Accepted

## Context

`requireMembership` verifies the caller is an active member of
`:workspaceId`, attaching `req.member` and `req.workspace`. It returns 404
(never 403) to prevent workspace enumeration.

If a non-member requesting `GET /v1/workspaces/{someId}` received a `403
Forbidden`, that response itself would leak information: it confirms the
workspace *exists* (just that the caller can't access it), distinguishing
it from a workspace ID that doesn't exist at all. An attacker could use
this distinction to enumerate valid workspace IDs by observing which
return 403 vs. some other status, without ever needing valid credentials
for any of them.

## Problem Statement

How do you deny access to a resource the caller isn't authorized to see,
without the denial response itself revealing whether the resource exists?

## Decision

`requireMembership` throws `NotFoundError` (404) in every case where
access should be denied for a workspace: workspace ID fails UUID format
validation, no active `workspace_members` row exists for the caller, or
the workspace itself is missing or soft-deleted (`is('deleted_at', null)`
filter). All three cases produce an identical `404 Workspace not found`
response — a non-member and a request for a workspace that was never
created are indistinguishable from the outside.

This same reasoning is applied consistently elsewhere in the codebase,
most explicitly in `invite.service.js#previewInvite`, which intentionally
returns `{ is_valid: false, error }` for every failure case (not found,
expired, used) rather than distinct 404/410 responses — deliberate, to
avoid invite-token enumeration on this public, unauthenticated endpoint.

## Alternatives Considered

- **403 for "exists but not a member," 404 for "doesn't exist."** This is
  the more conventional REST-semantics choice (403 more precisely
  describes "you don't have permission"), and is in fact used elsewhere in
  the codebase for *resource-level* (not workspace-level) authorization —
  e.g. `role.js#requireAdmin` returns `ForbiddenError` (403) when a caller
  is a workspace member but lacks the admin role for an admin-only action.
  The distinction the codebase draws is specifically about *workspace
  membership itself* being enumerable, not about authorization failures in
  general — once you're confirmed to be inside a workspace, subsequent
  role checks within it use ordinary 403s because membership (and
  therefore the workspace's existence to you) is already established.
- **Uniform 404 for literally every authorization failure everywhere,
  including role checks.** Not what was implemented — `role.js`'s
  `requireAdmin`/`requireSelfOrAdmin` both throw `ForbiddenError` (403),
  and `dispute.service.js#getDispute` throws `ForbiddenError` when a
  non-admin, non-raiser tries to view a dispute. The 404-masking pattern
  is scoped specifically to the workspace *boundary* (is this workspace ID
  even something you have any relationship to), not to every permission
  check inside a workspace you're already confirmed to belong to.

## Rationale

The workspace ID is the outermost boundary of the entire authorization
model — every other permission check (`requireAdmin`, `requireSelfOrAdmin`,
per-service `isAdmin`/`callerId` comparisons) only runs *after*
`requireMembership` has already succeeded. Enumerating valid workspace IDs
would be the highest-value reconnaissance step for an attacker (it reveals
which workspaces exist before any deeper authorization even applies), which
is why this specific boundary gets the enumeration-resistant treatment
while inner boundaries don't need it — an attacker who has already proven
membership in a workspace has, by definition, already learned it exists.

## Trade-offs

- A legitimate user with a genuinely wrong/mistyped workspace ID gets the
  same "not found" message as a user probing for workspaces they don't
  belong to — slightly worse UX/debuggability in the honest-mistake case,
  in exchange for the security property.
- Client-side error handling can't distinguish "this workspace doesn't
  exist" from "you're not a member of this workspace" from the response
  alone — both must be handled identically by any UI built against this
  API (which is exactly the point).

## Consequences

- Any new workspace-scoped endpoint automatically inherits this property
  for free, since `requireMembership` runs once via `router.use(...)` at
  the top of `workspace.routes.js` (see ADR-0003) rather than being
  re-implemented per route.
- The pattern establishes a project convention worth following elsewhere:
  `invite.service.js#previewInvite`'s uniform `is_valid: false` response
  for not-found/expired/used invite tokens is the same anti-enumeration
  instinct applied to a second, structurally similar public-lookup
  endpoint.

## Related Files

- `src/middleware/workspace.js` (`requireMembership`)
- `src/middleware/role.js` (`requireAdmin`, `requireSelfOrAdmin` — the
  contrasting 403 case, applied only after membership is established)
- `src/services/invite.service.js` (`previewInvite` — same pattern applied
  to a different resource)
- `src/utils/errors.js` (`NotFoundError`, `ForbiddenError`)
