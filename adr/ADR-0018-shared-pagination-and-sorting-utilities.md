# ADR-0018: Shared Pagination and Sorting Utilities

**Status:** Accepted

## Context

List endpoints across the API need consistent, safe pagination
(`page`/`per_page`/`offset` math) and sorting (`?sort=field` parsing with
descending-prefix support and field whitelisting). Without a shared
implementation, each list endpoint would need to independently reimplement
the same arithmetic and whitelist logic, with the attendant risk of subtly
different variable names, defaults, and edge-case handling across
endpoints.

## Problem Statement

How do you provide a single, consistent implementation of
pagination/sorting logic across every list endpoint, so that a fix or
enhancement to either concern doesn't need to be independently applied at
every call site?

## Decision

- **`getPagination(query)`** (`utils/pagination.js`) is the single
  implementation, wired into every paginated list endpoint:
  `ledger.controller.js#listEntries`, `dispute.controller.js#listDisputes`,
  `container.controller.js#listCycles`,
  `audit.controller.js#getAuditLog`,
  `notification.controller.js#listNotifications`. It clamps `page` to a
  minimum of 1 and `per_page` to between 1 and 100, and returns
  `{ page, perPage, offset }` ready to pass directly to a Supabase
  `.range(offset, offset + perPage - 1)` call.
- **`getSort(query, { allowed, defaultField, defaultDescending })`**
  (`utils/sorting.js`) mirrors `getPagination`'s shape deliberately: same
  calling convention (pass config, get back a ready-to-use result), same
  whitelist-based safety property — any `sort` value not in the `allowed`
  list silently falls back to `defaultField` rather than being passed
  through to the query builder unchecked. Used by
  `container.service.js#listContainers`,
  `ledger.service.js#listEntries`, `task.service.js#listTasks`, and
  `member.service.js#listMembers`.
- **No raw-SQL order-by helper exists**, since every query in this
  codebase goes through the Supabase JS query builder's `.order(field, {
  ascending })` — there is no raw-SQL call site anywhere in the app that
  would need a raw `"field DIRECTION"` string builder, so no such helper
  is maintained.

## Alternatives Considered

- **Fix each controller's inline pagination/sorting logic independently,
  in place, without extracting a shared utility.** Rejected — N
  independent implementations invites drift and repeated bugs; a shared
  utility resolves the duplication at its root rather than patching each
  symptom individually.
- **Maintain a second, "more complete" sorting helper for potential future
  raw-SQL use cases.** Rejected — speculative infrastructure for a
  raw-SQL call site that doesn't exist anywhere in the app would just be
  an unused utility waiting to happen, the exact class of problem this
  design avoids.

## Rationale

The whitelist-based safety property in `getSort` (falling back to
`defaultField` for any `sort` value outside `allowed`) is the sorting
equivalent of the ILIKE-escaping approach in `utils/ilike.js` (used by
`search.service.js` and `member.service.js`) and the CIDR/timing-safe
checks guarding the Bull Board admin dashboard — all three are instances
of the same underlying discipline: *any* value that ultimately flows into
a query or comparison from user-controlled input (`req.query.sort`, a
search string, an IP address, a password) gets validated or escaped at a
single, shared choke point rather than trusted ad hoc at each of its
several call sites.

## Trade-offs

- Both utilities intentionally clamp/whitelist rather than reject
  invalid input outright (an out-of-range `per_page` is silently clamped,
  not a `400`; an unrecognized `sort` field silently falls back to the
  default, not a `400`) — a permissive design choice that prioritizes
  "the endpoint still returns something reasonable" over "the client is
  told their input was invalid," which is a different philosophy than the
  strict-rejection approach chosen for `payment_method` in ADR-0016. This
  is a legitimate, defensible difference (pagination/sorting parameters
  are a UX nicety where silent correction is low-risk; a financial field
  like payment method is not), reflecting the differing risk profile of
  each input class.
- `getSort`'s `allowed` list must be kept in sync with the columns each
  endpoint's underlying query actually supports ordering by — a single
  point of maintenance, but still manually curated per call site rather
  than derived from, say, an actual database schema introspection.

## Consequences

- Every list endpoint using `getPagination`/`getSort` gets the exact same
  clamping/whitelisting behavior automatically, and a future fix to either
  utility (e.g. changing the max `per_page` from 100 to 50) is a one-line
  change that propagates to every consumer instead of requiring N
  edits across N controllers.
- Treating "utility exists but has zero call sites" as itself worth
  resolving (by wiring it in fully or not maintaining it at all) is a
  useful precedent for any future utility extraction in this codebase.

## Related Files

- `src/utils/pagination.js`
- `src/utils/sorting.js`
- `src/utils/ilike.js` (the same choke-point-sanitization pattern applied
  to a different input class)
- `src/controllers/ledger.controller.js`,
  `src/controllers/dispute.controller.js`,
  `src/controllers/container.controller.js`,
  `src/controllers/audit.controller.js`,
  `src/controllers/notification.controller.js` (pagination consumers)
- `src/services/container.service.js`, `src/services/ledger.service.js`,
  `src/services/task.service.js`, `src/services/member.service.js`
  (sorting consumers)
