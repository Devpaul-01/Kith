# ADR-0012: Idempotency Keys on Financial Ledger Writes

**Status:** Accepted

## Context

`POST /ledger` records a financial contribution. Any client-side retry
logic (network timeout, double-tap on a slow connection, a mobile client
retrying a failed request) risks submitting the same contribution twice.
For a financial ledger, a duplicate write isn't a cosmetic bug — it
directly misstates how much a family member has actually contributed.

## Problem Statement

How do you let clients safely retry a financial write after an ambiguous
failure (e.g. a network timeout where the server may or may not have
processed the request) without either rejecting legitimate retries or
risking duplicate financial entries?

## Decision

`ledger.controller.js#createEntry` reads an `X-Idempotency-Key` header
from the request, expected to be a client-generated UUID sent once per
submission attempt, guaranteeing exactly-once recording.

`ledger.service.js#createEntry` checks for an existing entry with that
exact `idempotency_key` (scoped to the workspace) *before* doing any other
work. If found, it returns the existing entry with `{ idempotent: true }`
and the controller responds `200` instead of `201` — the retry is
recognized and short-circuited rather than creating a second entry.

This idempotency-key path is the *primary* duplicate-prevention mechanism,
distinct from — and preferred over — a secondary heuristic: without an
idempotency key (or with the feature flag disabled), the service falls
back to a *time-window* duplicate check (`tenMinutesAgo`, matching
container/contributor/amount) that requires the client to pass
`?force=true` to override a suspected duplicate. The idempotency-key path
skips this heuristic entirely (`if (!force && !(idempotencyKey &&
IDEMPOTENCY_ENABLED))`), because an exact-match idempotency key is a
stronger, deterministic signal than a fuzzy heuristic.

The feature is gated by `IDEMPOTENCY_ENABLED` (default: **on**), reflecting
that the `idempotency_key` column and its unique constraint are a
confirmed, permanent part of the schema.

## Alternatives Considered

- **Time-window duplicate detection only (no idempotency key).** This is
  exactly the fallback path that still exists in the code — matching
  container + contributor + amount within a 10-minute window. Kept as a
  fallback (and as the mechanism for clients that don't send an
  idempotency key), but not relied on as the primary mechanism because it
  is a heuristic: a genuinely different contribution of the same amount
  from the same person within 10 minutes would trigger a false positive,
  requiring the `force=true` escape hatch — a real UX cost the exact-match
  idempotency key avoids entirely.
- **Database unique constraint alone, surfaced as a 409 to the client.**
  The unique constraint on `idempotency_key` exists and is the backstop if
  the service-level check were ever bypassed — but relying on it *alone*
  would mean every retry produces a raw constraint-violation error for the
  client to interpret, rather than the graceful "here's your original
  entry, respond 200" behavior the service-level pre-check provides.

## Rationale

Framing the guarantee as "exactly-once recording" is a precise, testable
claim about a financial write, not a vague "we try to avoid duplicates."
Building this as an explicit, documented contract (a specific header, a
specific response-shape difference between first-write and retry) makes
the guarantee something a client integration can rely on and test against,
rather than an implicit best-effort behavior.

## Trade-offs

- Idempotency keys are scoped to `workspace_id`, not globally — this is a
  reasonable scope (a UUID collision across two different workspaces is
  irrelevant) but is worth knowing if idempotency keys were ever generated
  in a way that wasn't already workspace-unique by construction (e.g. a
  purely random UUID, which sidesteps this entirely).
- Clients that don't send the header fall back to the weaker, heuristic
  time-window check — the strong guarantee is opt-in per request, not
  universally enforced by the server regardless of client behavior.

## Consequences

- The `?force=true` query parameter exists specifically as the escape
  hatch for the *heuristic* fallback path's false positives — it has no
  effect on (and isn't needed for) the idempotency-key path, since an
  idempotency-key match is definitionally a real duplicate, not a
  suspected one.
- Any future endpoint with similar "financial write that clients might
  retry" characteristics (e.g. if a second money-movement endpoint were
  added) has a documented, working precedent to copy rather than needing
  to re-derive the exactly-once pattern from scratch.

## Related Files

- `src/services/ledger.service.js` (`createEntry`, `IDEMPOTENCY_ENABLED`)
- `src/controllers/ledger.controller.js` (`createEntry` —
  `X-Idempotency-Key` read, 200-vs-201 response shaping)
