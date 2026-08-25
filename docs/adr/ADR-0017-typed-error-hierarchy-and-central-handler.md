# ADR-0017: Typed Error Hierarchy with a Central Error Handler

**Status:** Accepted

## Context

Services throughout the codebase need to signal a range of distinct
failure conditions — a missing resource, a caller lacking permission, a
business rule violation (e.g. "cannot delete a container with confirmed
ledger entries"), a conflicting duplicate, a validation problem discovered
mid-service rather than at the schema layer — and every one of these needs
to become a specific, correct HTTP status code and a consistent JSON error
shape by the time it reaches the client, regardless of which of the
thirteen controllers or dozens of service files raised it.

## Problem Statement

How do you let deeply-nested service functions signal precise failure
semantics (404 vs. 403 vs. 409 vs. 422 vs. 400) without every controller
needing its own bespoke try/catch/status-code logic, and without losing
information about *why* a request failed by the time it's logged or
returned to the client?

## Decision

A small class hierarchy in `utils/errors.js`, all extending a common
`AppError(message, statusCode, code, details)` base:

- `ValidationError` → 400, `VALIDATION_FAILED`
- `UnauthorizedError` → 401, `UNAUTHORIZED`
- `ForbiddenError` → 403, `FORBIDDEN`
- `NotFoundError` → 404, `NOT_FOUND`
- `ConflictError` → 409, `CONFLICT`
- `BusinessRuleError` → 422, `BUSINESS_RULE_VIOLATION`
- `RateLimitError` → 429, `RATE_LIMITED`

Every controller function follows the same `try { ... } catch (err) {
next(err) }` shape, identically across all thirteen controllers,
delegating entirely to one centralized Express error-handling middleware
(`errorHandler.js`) rather than each controller mapping errors itself.
`errorHandler` special-cases exactly three input shapes, in order:

1. `ZodError` (validation, caught before it would otherwise become a
   generic 500) → 400 with a `field`/`details` array shaped from Zod's own
   issue list.
2. `AppError` (and subclasses) → the error's own `statusCode`/`code`,
   with `500`+ instances specifically logged at `error` level (lower
   severity `AppError`s like a 404 or 422 are expected, routine outcomes,
   not incidents).
3. Two specific raw Postgres error codes — `23505` (unique violation) →
   409, `23503` (foreign-key violation) → 422 — recognized directly by
   code rather than requiring every service to catch and re-wrap them.

Anything not matching one of these three shapes falls through to a
generic `500 INTERNAL_ERROR`, with the *message* only exposed in
non-production environments (`process.env.NODE_ENV === 'production' ? 'An
internal error occurred' : err.message`) — deliberately hiding internal
error detail from production clients while still logging the real message
server-side.

## Alternatives Considered

- **Per-controller error handling (no central middleware).** Would let
  each controller customize its response shape, but is precisely the
  pattern the layered controller/service architecture (ADR-0002) moves
  away from — thirteen independently-maintained error-shaping
  implementations would recreate the kind of duplication addressed
  elsewhere in the codebase (rate limiting, pagination, sorting, ILIKE
  escaping).
- **Generic `Error` with string-matching in the handler (e.g. checking
  `err.message.includes('not found')`).** Rejected — the typed hierarchy
  exists specifically so status-code selection is a property of the
  error's *type*, not a fragile string match against its message, which
  would break the moment a message's wording changed.
- **Let Postgres errors bubble up as raw 500s always.** Not done for the
  two most common, meaningfully-recoverable Postgres error codes (`23505`,
  `23503`) — these are given specific, more useful status codes (409, 422)
  directly in the central handler rather than requiring every service
  function that might trigger a duplicate-key or FK violation to catch and
  translate it individually.

## Rationale

`dispute.service.js#getDispute`'s `.maybeSingle()` + explicit-404 pattern
shows the alternative this hierarchy replaces: using `.single()` would
have thrown a raw Postgrest error on a missing referenced entry. A raw
Postgrest error reaching the client would have an inconsistent,
provider-specific shape and an unpredictable status code — using
`NotFoundError` instead guarantees a `404` with the standard `{ error:
{ code, message } }` envelope every other error in the system uses,
regardless of which underlying database call produced it.

## Trade-offs

- Every service function that wants a specific status code must remember
  to throw the correct `AppError` subclass rather than a generic `Error`
  — a generic `throw new Error(...)` (used throughout the service layer
  for genuinely unexpected DB errors, e.g. `if (error) throw new
  Error(error.message)`) always falls through to a plain 500, which is
  the correct behavior for truly unexpected failures but means the
  distinction between "an expected, typed business failure" and "an
  unexpected infrastructure failure" depends on which throw form each
  service author chose at each call site.
- The `23505`/`23503` special-casing in `errorHandler.js` is somewhat
  coupled to Postgres specifically (these are Postgres SQLSTATE-derived
  codes surfaced by Supabase's client) — the same vendor-coupling
  trade-off already discussed in ADR-0004 shows up here too, in the
  error-handling layer specifically.

## Consequences

- Log severity is automatically calibrated by error type — `AppError`s
  with `statusCode >= 500` are logged as `error`, while lower-severity
  `AppError`s (404s, 422s, 409s — all "the system worked correctly and
  told the client no") are not logged as errors at all, keeping
  application logs focused on genuine incidents rather than routine
  client-facing rejections.
- Any new business rule anywhere in the service layer can be enforced
  with a one-line `throw new BusinessRuleError('...')` and immediately get
  correct HTTP semantics, consistent response shape, and correct log
  severity — no additional wiring required per call site.

## Related Files

- `src/utils/errors.js`
- `src/middleware/errorHandler.js`
- `src/services/dispute.service.js` (`getDispute` — the `.maybeSingle()` +
  explicit-`NotFoundError` pattern)
- Every `src/controllers/*.controller.js` (uniform `try { } catch (err) {
  next(err) }` shape)
