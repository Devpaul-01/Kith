# ADR-0007: Short-Lived Redis Cache for Workspace Membership

**Status:** Accepted

## Context

`requireMembership` (in `middleware/workspace.js`) runs on every single
route mounted under `workspace.routes.js` — dozens of endpoints across
members, groups, containers, participants, ledger, disputes, tasks, and
milestones — since it's applied once via `router.use(...)` at the top of
that router. Its job is to verify the caller is an active member of
`:workspaceId` and attach `req.member`/`req.workspace`. Absent caching,
this means two DB round trips (`workspace_members` + `workspaces`) on
*every* authenticated workspace-scoped request, even when a client fires
several sub-requests in quick succession (e.g. a dashboard screen firing
several sub-requests).

## Problem Statement

How do you remove two DB round trips from the hottest middleware in the
application without either (a) making authorization decisions on stale
data indefinitely, or (b) adding an invalidation mechanism so complex it
becomes its own source of bugs?

## Decision

Cache the combined `{ member, workspace }` payload in Redis for
`TTL.MEMBERSHIP_CACHE_SECONDS` (30 seconds, defined in
`config/redis-keys.js`), keyed by `kith:membership:{workspaceId}:{userId}`.
`requireMembership` checks the cache first; on a hit it skips both DB
queries entirely. On a miss, it fetches both rows in parallel
(`Promise.all`) and writes the result to cache fire-and-forget (never
blocking the request on the cache write).

Because the cached payload includes authorization-relevant fields (`role`,
`is_active`), the design explicitly pairs the 30-second TTL with immediate,
targeted invalidation on every write path that changes those fields:

- `member.service.js#updateMember` calls `invalidateMembership(workspaceId,
  userId)` whenever `role`, `is_active`, `is_proxy`, or `proxy_managed_by`
  changes (`authRelevantChanged` check).
- `member.service.js#deleteMember` invalidates on removal.
- `membership-cache.service.js#invalidateWorkspace` uses Redis `SCAN`
  (not `KEYS`, to avoid blocking on large keyspaces) to clear every cached
  membership for a workspace at once, for workspace-wide events.

This 30-second bounded-staleness window is an explicit, intentional
product decision: the only residual staleness applies to state changes
made outside the application entirely, or any future write path that
forgets to call invalidate — bounded to a maximum of
`TTL.MEMBERSHIP_CACHE_SECONDS` either way.

The cache fails open: any Redis read or write error is caught, logged as a
warning, and treated as a cache miss/no-op — falling back to Postgres,
never blocking or denying a request due to Redis unavailability.

## Alternatives Considered

- **No cache; two DB queries per request, always.** The status quo this
  ADR replaces. Simpler and always-fresh, but two round trips on the
  hottest path in the app.
- **Cache with no TTL, invalidate-only.** Would tighten the staleness
  window to zero *if* every write path remembered to invalidate, but
  removes the bounded-staleness safety net the current design explicitly
  relies on as a backstop against a future write path forgetting to
  invalidate (or an out-of-band DB edit).
- **Longer TTL (e.g. 5 minutes) for a bigger cache-hit win.** Would reduce
  DB load further but widen the acceptable-staleness window on
  authorization-relevant data — 30 seconds was chosen as a specific,
  tunable product decision, with the TTL centralized in `redis-keys.js`
  specifically so it can be adjusted without touching the cache logic
  itself.
- **Fail closed on Redis error (deny the request).** Rejected — a cache
  miss or error should mean "fetch from Postgres like before," never a
  wrongly-denied (or wrongly-granted) request. Fail-open here refers to
  falling back to the authoritative source, not to skipping authorization.

## Rationale

`bank_details` is explicitly *not* selected in the underlying
`requireMembership` query — nothing in the codebase reads
`req.workspace.bankDetails`, so fetching it into every single
workspace-scoped request would be pure overhead on a sensitive jsonb
column with no consumer. This is the same instinct that motivates the
cache itself: `requireMembership` runs so often that even small
per-request costs (an unused column, two round trips) compound across the
entire application's request volume, so both were addressed together.

## Trade-offs

- A 30-second window exists where a just-demoted admin, or a just-removed
  member, could still pass `requireMembership` using stale cached data —
  *unless* the specific write path that caused the change remembers to
  call `invalidateMembership`/`invalidateWorkspace`. This is a real,
  accepted risk, not a theoretical one.
- Two more Redis round trips are added to the hot path in the cache-hit
  case (one `GET`) and cache-miss case (one `SET`, fire-and-forget) — a
  net win only because Redis latency is expected to be far lower than the
  two Postgres queries it replaces.

## Consequences

- Any future feature that changes a workspace member's `role`, `is_active`,
  `is_proxy`, or `proxy_managed_by` outside of `member.service.js#updateMember`/
  `deleteMember` must remember to call `invalidateMembership` — this is an
  implicit contract enforced by convention and code review, not by the
  type system.
- The same `TTL`/key-naming pattern
  (`config/redis-keys.js`'s `membershipKey`) is reused by the unrelated
  `lastSeenKey`/`shouldUpdateLastSeen` debounce in `middleware/auth.js`,
  establishing a shared convention for "short-lived, best-effort Redis
  state keyed by user" across the codebase.

## Related Files

- `src/services/membership-cache.service.js`
- `src/middleware/workspace.js`
- `src/config/redis-keys.js`
- `src/services/member.service.js` (`updateMember`, `deleteMember` —
  invalidation call sites)
