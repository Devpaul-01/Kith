# ADR-0006: Redis-Backed, Dual-Tier Rate Limiting

**Status:** Accepted (supersedes an earlier single-limiter design)

## Context

The application needs two genuinely different rate-limiting guarantees: a
baseline defense-in-depth ceiling that applies to *every* request
including fully unauthenticated ones, and a per-user throttle that
protects one heavy authenticated user from consuming a shared quota (e.g.
many legitimate users behind one corporate NAT). A single limiter mounted
at a single point in the middleware chain cannot deliver both, because
whether `req.user` is populated at the point a limiter's key generator
runs depends entirely on where in the chain the limiter sits.

An earlier design used a single `generalLimiter` keyed as `req.user?.id ||
req.ip`, mounted globally in `app.js` before any auth middleware ran. Since
`req.user` was never populated at that point in the chain, the limiter
silently fell back to IP-based limiting for 100% of traffic rather than
the intended per-user behavior.

## Problem Statement

How do you provide both a baseline, IP-keyed rate limit for all traffic
and a genuinely per-user rate limit for authenticated traffic, given that
"is `req.user` populated yet" depends entirely on where in the middleware
chain a limiter sits?

## Decision

Two separate limiter instances, each mounted at the point in the request
pipeline where its key actually exists:

- **`generalLimiter`** — mounted globally in `app.js`, *before* any auth
  middleware runs (`app.use(generalLimiter)` appears before `cookieParser`
  and before any route handler). Deliberately IP-keyed
  (`keyGenerator: perIpKey`), 200 requests/minute — a correctly-scoped,
  by-design IP baseline covering every request, authenticated or not.
- **`userGeneralLimiter`** — mounted in `workspace.routes.js`, *after*
  `requireAuth` has already run (`router.use(requireAuth, loadDbUser,
  requireMembership, userGeneralLimiter)`), where `req.user.id` is
  guaranteed populated. Keyed by `perUserKey` (`req.user?.id || req.ip`),
  same 200/minute ceiling, but now genuinely per-user.

Beyond this general/user split, purpose-specific limiters exist for
distinct threat models: `authLimiter` (5/min per IP — no identity exists
yet at login/signup), `inviteLimiter` (10/hour per user — mounted after
`requireAuth`), `uploadLimiter` (20/hour per user), and
`publicLookupLimiter` (30/min per IP, specifically for unauthenticated
lookup endpoints like invite preview and public container view).

All limiters share one Redis-backed store (`rate-limit-redis`'s
`RedisStore`, using the same `ioredis` connection BullMQ and the
membership cache use), so limits are enforced correctly across every
instance behind a load balancer rather than each instance keeping an
independent in-memory counter.

## Alternatives Considered

- **Fix the key generator to be conditionally IP-or-user without changing
  mount point.** Would not work — the issue isn't the key generator logic
  (`req.user?.id || req.ip` is a reasonable fallback expression), it's that
  `req.user` is structurally unavailable at that point in the chain no
  matter what the expression says. The fix has to be architectural (move
  the per-user limiter to after auth), not a code tweak.
- **In-memory rate limiting (no Redis).** `buildStore()` in
  `rateLimiter.js` falls back to this automatically if Redis is
  unavailable, with an explicit warning logged that limits will not be
  shared across instances. This is a resilience fallback, not the primary
  design — the codebase treats it as degraded-mode behavior, not a real
  alternative for a multi-instance deployment.
- **A single limiter with two different windows depending on
  `req.user`.** Splitting into two limiter *instances*, each scoped to
  where its key is valid, is more explicit about the "before auth" vs.
  "after auth" distinction than a single limiter branching internally
  would be, and makes the ordering invariant visible at the mount-point
  level rather than buried in a conditional.

## Rationale

`publicLookupLimiter` reflects the same reasoning applied a second time:
`generalLimiter`'s 200/min IP-based baseline is too loose to be a
meaningful anti-enumeration control on its own against token-space
enumeration on endpoints like invite preview. A tighter, purpose-built
30/min-per-IP limiter exists specifically for these public, unauthenticated
lookup endpoints rather than relying on the general baseline to cover
every threat model.

## Trade-offs

- Six distinct limiter instances (`authLimiter`, `inviteLimiter`,
  `uploadLimiter`, `publicLookupLimiter`, `generalLimiter`,
  `userGeneralLimiter`) means six independent windows/thresholds to reason
  about and tune, rather than one.
- An authenticated user hitting a workspace-scoped endpoint is subject to
  *two* limiters simultaneously (the global IP-based `generalLimiter` in
  `app.js`, and the per-user `userGeneralLimiter` in
  `workspace.routes.js`) — intentional defense-in-depth, but it does mean
  a shared-IP scenario (e.g. office NAT) could still hit the IP baseline
  even though each individual user is well within their own per-user
  quota.

## Consequences

- The mount-point-determines-correctness pattern established here (a
  limiter is only as correct as its position in the middleware chain
  relative to auth) is the documented convention for any future limiter.
- Redis becomes a hard dependency for *correct* (not just functional) rate
  limiting in any multi-instance deployment; the in-memory fallback exists
  for availability but silently changes the guarantee being provided.

## Related Files

- `src/middleware/rateLimiter.js`
- `src/app.js` (`generalLimiter` mount point + explanatory comment)
- `src/routes/workspace.routes.js` (`userGeneralLimiter` mount point)
- `src/routes/invite.routes.js`, `src/routes/public.routes.js`
  (`publicLookupLimiter` usage)
