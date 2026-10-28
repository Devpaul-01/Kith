# ADR-0016: Zod Schema Validation with Shared Enum Sources of Truth

**Status:** Accepted

## Context

Request validation is handled by Zod schemas in `src/validators/`, called
directly from controllers (`schema.parse(req.body)` or
`schema.safeParse(req.body)`), with `errorHandler.js` centrally catching
`ZodError` and shaping a consistent `400 VALIDATION_FAILED` response with
per-field details. Several conceptual values — recurrence cadences, family
types, payment methods — are shared across more than one schema and, in
places, need to stay consistent with the database's own constraints.

## Problem Statement

When the same conceptual value (e.g. "what recurrence cadences are valid,"
"what family types are valid") is validated in more than one Zod schema,
how do you prevent the two copies from silently diverging — either from
each other, or from the actual database CHECK constraint enforcing the
same rule at the storage layer?

## Decision

- **Shared constants, single source of truth.** `workspace.validator.js`
  exports `FAMILY_TYPES` and `RECURRENCE_CADENCES` as module-level arrays,
  so this list stays the single source of truth, and both
  `createContainerSchema`/`convertToRecurringSchema` (for cadence) and
  `createWorkspaceSchema`/`updateWorkspaceSchema` (for family type) import
  the same array rather than each declaring an inline enum.
  `SUPPORTED_CURRENCIES` in `auth.validator.js` is exported and imported by
  `ledger.validator.js` and `workspace.validator.js` for the same reason.
- **Widen the database to match the validator, not the reverse, when a
  real mismatch is found.** `FAMILY_TYPES` is intentionally wider than an
  earlier version of the live DB constraint, so the database was widened
  to match the already-shipped validator rather than narrowing the
  validator — narrowing would have been a breaking API change for any
  client already sending these values. The same reasoning applies to
  `recurrence_cadence`: `createContainerSchema`'s cadence enum includes
  `'weekly'`, matched by both the database CHECK constraint and an actual
  `case 'weekly'` branch in the cycle-generation worker, so the value is
  fully honored end to end rather than accepted and silently mistreated as
  `monthly`.
- **Reject unknown input rather than silently normalizing it.**
  `ledger.validator.js`'s `payment_method` field keeps normalization for
  known synonyms (`"Bank Transfer"` → `bank_transfer`, etc., so existing
  clients keep working unchanged) but calls `ctx.addIssue(...)` and
  returns `z.NEVER` for anything not in the known-synonym map, turning
  silent miscategorization into an explicit validation error rather than
  swallowing garbage input as `'other'`.

## Alternatives Considered

- **Keep enums duplicated per-schema for schema-file independence.**
  Rejected — two independently-maintained copies of the same list will
  eventually drift, and the current design explicitly consolidates rather
  than duplicating.
- **Narrow the validator to match a stricter database when a mismatch is
  found.** Explicitly rejected for `FAMILY_TYPES` — doing so would be a
  breaking API change for any client already sending values the validator
  had already been advertising as accepted.
- **Silently coerce unrecognized payment-method values to `'other'`.**
  Rejected — silent coercion of garbage input was judged worse than a
  validation error, even though it means a slightly stricter contract for
  existing clients (mitigated by keeping known synonyms working).

## Rationale

The `RECURRENCE_CADENCES` design is the clearest end-to-end example of why
these three decisions (shared source of truth, widen-DB-not-narrow-
validator, and actually *using* the newly-valid value) work together:
widening only the DB constraint without adding the `case 'weekly'` branch
in the cycle-generation worker would mean `'weekly'` passes validation,
passes the DB constraint, and then gets silently mishandled by business
logic that doesn't know how to generate weekly cycles — a
three-layer concern (validator, schema, worker logic) that requires a
three-layer, coordinated design.

## Trade-offs

- Centralizing enums in `auth.validator.js` and `workspace.validator.js`
  means those two files are cross-imported by `ledger.validator.js` and
  each other — a small increase in inter-file coupling within the
  validators directory, in exchange for eliminating drift risk.
- Rejecting unknown `payment_method` values is a stricter contract: any
  client sending a genuinely new payment method string not yet in the
  known-synonym map gets a `400` instead of a silent `'other'`
  categorization, which is correct behavior but does mean the
  known-synonym map itself must be kept up to date as new payment methods
  are supported.

## Consequences

- `errorHandler.js`'s centralized `ZodError` handling
  (`firstError`/`details` array shaping) means every validator file
  benefits from the same consistent error response shape without needing
  to format errors itself — this pairs directly with ADR-0017's typed
  error hierarchy.
- Any future enum needed in more than one schema has an established,
  documented precedent for why it must be extracted to a shared constant
  rather than inlined twice.

## Related Files

- `src/validators/workspace.validator.js` (`FAMILY_TYPES`,
  `RECURRENCE_CADENCES`)
- `src/validators/auth.validator.js` (`SUPPORTED_CURRENCIES`)
- `src/validators/ledger.validator.js` (`payment_method` normalization and
  rejection logic)
- `src/services/cycle_generation.service.js` (`case 'weekly'` — the
  business-logic half of the recurrence-cadence design)
- `src/middleware/errorHandler.js` (`ZodError` handling)
