# ADR-0002: Layered Controller/Service Architecture

**Status:** Accepted

## Context

Every controller in `src/controllers/` follows a consistent shape: parse
the request, call one service function, shape the response. Business
logic — Supabase queries, RPC calls, validation-adjacent business rules,
notification dispatch, audit logging — lives entirely in
`src/services/*.service.js`. This separation exists so business logic can
be unit tested without spinning up Express, and so the same logic can be
reused from background workers and scripts, not just HTTP handlers.

## Problem Statement

How should HTTP request parsing, business/validation logic, and database
access be separated so that (a) business logic can be unit tested without
spinning up Express, (b) the same logic can be reused from background
workers, and (c) controllers stay small enough to review at a glance?

## Decision

Adopt a strict three-layer split, applied uniformly across the entire
`src/` tree:

1. **Controllers** (`src/controllers/*.controller.js`) — parse
   `req.params`/`req.query`/`req.body`, run Zod schema validation, call
   exactly one service function, and shape the HTTP response via
   `utils/response.js`'s `success()`/`paginate()`/`noContent()` helpers.
   Controllers never call Supabase directly and never contain business
   rules.
2. **Services** (`src/services/*.service.js`) — all database reads/writes,
   business rules, notification dispatch, audit logging, and queue
   enqueueing. Services are plain async functions taking a single
   destructured options object and returning plain data — no `req`/`res`
   ever appears in a service signature.
3. **Workers** (`src/workers/*.worker.js`, `background.workers.js`) — thin
   BullMQ `Worker` wrappers that pull a job and call the *same* service
   functions the controllers call, or dedicated worker-only services (e.g.
   `cycle_generation.service.js`, `reminder.service.js`) when the trigger is
   a cron job rather than an HTTP request, rather than duplicating logic.

Validation schemas live in a fourth, parallel layer
(`src/validators/*.validator.js`, Zod) that controllers import directly —
validation is treated as a request-parsing concern, not a service concern.

## Alternatives Considered

- **Fat controllers, no service layer.** Rejected — this prevents reuse
  (e.g. dashboard aggregation logic could not be called from a worker) and
  makes controllers hundreds of lines long.
- **Repository pattern (a data-access layer between services and Supabase).**
  Not adopted. Supabase's client already *is* a reasonably ergonomic query
  builder, and every service in this codebase calls `supabaseAdmin` directly
  rather than through a further abstraction. Given the project uses exactly
  one database provider, an additional repository layer would add
  indirection without adding portability — there's no second database
  implementation it would ever need to swap toward.
- **Fat models with logic on domain objects (ActiveRecord-style).** Not
  applicable — Supabase's client returns plain rows, not domain objects, so
  there's no natural place to attach behavior this way without introducing
  an ORM the project doesn't otherwise use.

## Rationale

The controller/service split directly serves two concrete needs in this
codebase:

- **Worker reuse without duplication.** `engagement.service.js` computes
  member engagement stats once, in a shared `fetchEngagementData`/
  `computeEngagement` implementation, called by both
  `member.service.js#getMemberEngagement` (API) and
  `engagement_check.service.js#runEngagementCheck` (background worker) —
  a single batched implementation rather than two independently-maintained
  ones.
- **Thin, auditable HTTP boundaries.** Every controller function in the
  codebase follows the same three-line shape: parse → call service →
  respond. This makes the HTTP contract (status codes, response shape,
  auth/validation ordering) reviewable independently of business logic.

## Trade-offs

- More files and more indirection per feature — adding an endpoint now
  means touching a route, a controller function, a service function, and
  usually a validator schema, instead of one file.
- Services accept large destructured option objects
  (`{ workspaceId, containerId, data, actorMemberId, actorCtx }`) rather
  than typed parameter objects, which trades some IDE-assisted safety for
  flexibility — there's no TypeScript in this project to enforce shape at
  the boundary.

## Consequences

- Business logic is independently testable without an HTTP server.
- Notification, audit-logging, and queue-enqueueing calls are consistently
  colocated with the business operation that triggers them (e.g.
  `container.service.js#completeContainer` sends a notification, writes an
  audit log entry, and creates a milestone all in one service function),
  rather than being scattered across controller callback chains.
- The pattern is load-bearing enough that any new endpoint that skips the
  service layer would be a visible deviation from every existing file in
  the codebase — the convention is self-enforcing by precedent.

## Related Files

- `src/controllers/*.controller.js` (all thirteen)
- `src/services/*.service.js` (all corresponding services)
- `src/services/engagement.service.js` (shared-implementation example)
- `src/utils/response.js`
