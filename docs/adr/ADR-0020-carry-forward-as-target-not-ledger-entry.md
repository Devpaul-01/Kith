# ADR-0020: Carry-Forward Represented as a Target Increase, Not a Ledger Entry

**Status:** Accepted

## Context

A recurring container with `carry_forward_unpaid` enabled is meant to
roll an unpaid balance into the next cycle rather than letting it quietly
disappear when a cycle closes. The original implementation
(`cycle_lifecycle.service.js#carryForwardUnpaid`) did this by inserting a
new `ledger_entries` row for the outstanding amount, attributed to the
next cycle, with `entry_type: 'carry_forward'` and — critically —
`status: 'confirmed'`.

## Problem Statement

`status: 'confirmed'` means exactly one thing everywhere else this
codebase reads the ledger: money was actually received. Every summary
that aggregates ledger entries — dashboard overdue/paid totals, a
container's confirmed total, a member's contribution summary, the invite
preview's container snapshot, `participant.service.js#getCycleTargets`'s
paid-vs-target comparison — sums `status = 'confirmed'` rows as money in
hand. Inserting a *confirmed* entry for an amount the participant has
**not** paid made them look, in every one of those views, like they had
already paid it in the new cycle. The product's own goal — "don't let an
unpaid balance quietly vanish, make the new cycle honestly reflect the
accumulated obligation" — was being defeated by the exact mechanism meant
to achieve it: an obligation was being recorded as a payment.

This also carried a latent correctness bug: the insert set
`recorded_by: null` against a column that is `NOT NULL` in the schema
(`001_schema.sql`), with a code comment anticipating a `002_hardening.sql`
migration to relax it that was never written. In practice, this meant the
insert would throw on every run for any container with
`carry_forward_unpaid` enabled and at least one outstanding participant —
and because the exception propagated up through `closeDueCycles`, the
cycle would be reopened for retry and fail again the next day,
indefinitely.

## Decision

Carry-forward no longer touches `ledger_entries` at all. Instead,
`apply_cycle_carry_forward_atomic` (in
`002_ledger_integrity_and_carry_forward_debt.sql`) raises the
participant's **target** for the next cycle by the outstanding amount:

- It supersedes the participant's current `contributor_targets` row for
  the destination cycle — the same supersede-don't-mutate pattern
  `set_contributor_target_atomic` already uses for manual target edits
  (new row, `is_current = true`; old row `is_current = false`,
  `superseded_at`/`superseded_by` set) — with a `target_amount` equal to
  the previous target plus the carried amount, or just the carried amount
  if no target existed yet for that cycle.
- A new `cycle_carry_forwards` table records the source cycle, the
  destination cycle, the participant, and the amount — both as an audit
  trail and as the idempotency mechanism: a unique constraint on
  `(container_participant_id, from_cycle_id)` makes a second call for the
  same participant and closed cycle a guaranteed no-op
  (`{applied: false}`), replacing the previous approach of matching on
  ledger-entry note text, which was itself a non-atomic check-then-act —
  the same race class ADR-0010 already uses atomic RPCs to close
  elsewhere in this codebase.
- `cycle_lifecycle.service.js#carryForwardUnpaid` calls this RPC per
  outstanding participant instead of building and inserting a ledger
  row, and sends a new `carry_forward_applied` notification when a debt
  is actually applied (not on an idempotent no-op).

Debt now lives in `contributor_targets` — the table whose entire purpose
is "what is owed." `ledger_entries` stays exactly what ADR-0012 and the
new immutability trigger (ADR-0019) assume it is: a record of money that
has actually moved. The existing paid-vs-target comparison in
`participant.service.js#getCycleTargets` needed no changes at all to
correctly show a participant with a carried-forward debt as `partial` or
`overdue` until they actually pay the larger amount — it already compared
confirmed payments against the target; the target is simply larger now,
for the right reason.

## Alternatives Considered

- **Keep the ledger entry, but give it a non-`confirmed` status** (e.g. a
  dedicated `owed` status). Rejected: it would require every reader of
  ledger status across the codebase — dashboards, summaries, the dispute
  system's assumptions about what `confirmed` means — to learn a new
  exception, multiplying the blast radius of what should be a contained
  fix. It also doesn't change the underlying category error: an
  obligation isn't a transaction, regardless of what status label is
  attached to it.
- **Fix only the `recorded_by: null` bug, keep the `confirmed`
  carry-forward entry otherwise.** Would have resolved the crash but left
  the actual reporting error — unpaid balances counted as paid — fully
  intact, which is the problem that was actually raised.
- **A dedicated "debt" table separate from `contributor_targets`,
  reconciled at read time.** Would require every place that currently
  reads a participant's target (dashboard, cycle detail, exports) to
  additionally query and merge this new table. Rejected in favor of
  folding the amount directly into the existing target value, which
  every one of those call sites already reads.

## Rationale

The fix follows from correctly naming what carry-forward actually is: an
**obligation**, not a **transaction**. `contributor_targets` already
models obligations (what a participant is expected to contribute, per
cycle or standing); `ledger_entries` already models transactions (what
actually moved, with its own immutability and dispute machinery built
specifically around that meaning). Routing carry-forward through the
table whose semantics already match what it represents means every other
system that reads targets or reads confirmed payments continues to behave
correctly without being taught a new exception — the fix is contained to
the one place that was wrong.

## Trade-offs

- **Cross-currency carry-forward is explicitly unsupported**, not
  silently miscalculated: `apply_cycle_carry_forward_atomic` raises an
  exception if the outstanding amount's currency doesn't match the next
  cycle's existing target currency, rather than summing two different
  currencies as if they were the same unit (which is what the pre-existing
  code did implicitly, comparing a `target_currency`-denominated target
  against a `base_amount`-denominated paid sum). This is stricter than
  before by design — a loud failure for a case the original code got
  quietly wrong is preferable to extending that same quiet wrongness into
  the new path.
- **`carry_forward` remains a valid `ledger_entries.entry_type`** for
  historical rows written before this migration — it was not backfilled
  or removed, since doing so would rewrite financial history rather than
  just change how new events are recorded.

## Consequences

- Every existing summary/report that sums confirmed ledger entries needed
  zero changes — the bug and the fix were both fully contained to the
  carry-forward write path, not spread across readers.
- The `recorded_by: null` crash is resolved as a direct consequence of no
  longer writing to `ledger_entries` from this path at all, not via a
  schema change making the column nullable.
- A single participant's carry-forward failure (e.g. the cross-currency
  exception above) is now caught, logged, and skipped per participant
  rather than propagating up and reopening the entire cycle for retry —
  consistent with how `openDueCycles`'s per-participant notification
  sends are already handled in the same file.

## Related Files

- `migrations/002_ledger_integrity_and_carry_forward_debt.sql`
  (`cycle_carry_forwards` table, `apply_cycle_carry_forward_atomic`)
- `src/services/cycle_lifecycle.service.js` (`carryForwardUnpaid`,
  `closeDueCycles`)
- `src/services/participant.service.js` (`getCycleTargets` — unchanged,
  but the mechanism this ADR relies on reading correctly)
- `src/services/notification.service.js` (`carry_forward_applied` template)
