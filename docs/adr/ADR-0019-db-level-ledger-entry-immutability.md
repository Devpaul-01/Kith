# ADR-0019: Database-Level Immutability Trigger for Confirmed Ledger Entries

**Status:** Accepted

## Context

A confirmed ledger entry is supposed to be a permanent financial record.
`ledger.service.js` already enforces this: `updateEntry` only allows
changes while an entry is `pending`, `deleteEntry` only allows deletion
while `pending`/`proof_uploaded`, and any adjustment to a confirmed
entry has to go through a **correction** — a new, separate ledger row
referencing the original (`corrects_entry_id`), rather than mutating the
original's numbers in place.

This rule was raised directly by a prospective employer during a
technical conversation about the project, who asked specifically whether
it was enforced anywhere below the application layer.

## Problem Statement

Every query in this codebase goes through `supabaseAdmin`, the
service-role client, which bypasses Row-Level Security entirely (ADR-0005).
That means the "confirmed entries are corrected, not edited" rule lived
*only* in `ledger.service.js` — anything else touching the row directly
(a future script, a one-off fix run from the Supabase SQL console, a bug
in a new code path added later that forgets the check) could silently
edit or delete a confirmed financial record with nothing to stop it.
For a ledger specifically — the one table in this schema where
"permanent and provably correct" is the entire point — that gap is worth
closing at the layer the application layer can't bypass by construction.

## Decision

`migrations/001_schema.sql` defines two triggers on
`ledger_entries`:

- `enforce_ledger_entry_immutability()` (`BEFORE UPDATE`): once an
  entry's **current** status is `confirmed`, `disputed`, or `resolved`,
  every column is frozen except:
  - `status`, and only via a small whitelist of transitions
    (`confirmed → disputed`, `disputed → resolved`) — matching exactly
    the two RPCs (`raise_dispute_atomic`, `resolve_dispute_atomic`) that
    are allowed to change it.
  - `proofs`, since admins and contributors can still attach or remove
    proof files on a confirmed entry (`ledger.service.js#confirmProof` /
    `#deleteProof`) — that's a deliberate exception in the application
    rule too, not something this trigger should re-restrict.
  Any other attempted change raises an exception, using
  `to_jsonb(NEW) - 'status' - 'proofs' IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'proofs'`
  rather than enumerating columns by name, so a future `ALTER TABLE`
  adding a new column is covered automatically instead of silently
  falling outside the check.
- `prevent_locked_ledger_entry_delete()` (`BEFORE DELETE`): blocks
  deletion outright once an entry has reached `confirmed`/`disputed`/
  `resolved`, mirroring `deleteEntry`'s existing restriction.

Entries that haven't been confirmed yet (`pending`, `proof_uploaded`)
are untouched by either trigger and remain exactly as editable as they
are today.

## Alternatives Considered

- **Row-Level Security policies.** Would require switching this table's
  queries off the service-role client, or layering RLS on top of a
  service-role connection (which RLS does not apply to at all — ADR-0005).
  Not a fit without a much larger change to how this table specifically
  is accessed.
- **A Postgres `REVOKE UPDATE/DELETE` at the column or row level.**
  Column-level privileges can't express "frozen only once a specific
  status is reached"; a static grant can't be conditional on row state
  without a trigger doing the actual check regardless.
- **Leave it as application-layer only, documented as a known
  boundary.** This is exactly what Section 13 of SECURITY.md already
  does for every *other* table — "no database-level safety net, pair
  every new query with a check." That's a reasonable default for most
  of the schema. The ledger specifically is the one table where the
  downside of a missed application-layer check (a silently incorrect
  financial record) outweighs the cost of one more trigger.

## Rationale

A trigger is the one mechanism in Postgres that fires on every write to
a table regardless of which role, client, or code path issued it — it
doesn't require the caller to opt in the way an RLS policy or a
service-layer check does. For a single table with a single, well-defined
invariant ("frozen once confirmed, except two whitelisted status moves
and the proofs array"), that's a precise, cheap, and complete backstop —
not a general pattern this project adopts everywhere (see SECURITY.md
§13, item 1, which explicitly scopes this as the one exception).

## Trade-offs

- A trigger is one more piece of logic living in SQL rather than
  JavaScript, splitting the "what can happen to a ledger entry" rule
  across two places (`ledger.service.js` and the schema file) that now
  both need to stay in sync if the rule ever changes — e.g. a future
  `reversed` status flow would need the whitelist in *both* places
  updated together.
- Any direct-SQL maintenance operation on `ledger_entries` (a manual data
  fix, a future migration backfilling a column) now has to go through
  the same whitelist as application code, or explicitly disable the
  trigger (`ALTER TABLE ... DISABLE TRIGGER`) for the duration — a small
  but real operational friction, deliberately accepted since it's the
  same friction that makes the protection meaningful.

## Consequences

- A question like the founder's — "is this actually enforced, or just
  assumed?" — now has a verifiable yes at the database level, not just a
  pointer to application code that a sufficiently privileged caller could
  bypass.
- `cycle_lifecycle.service.js#carryForwardUnpaid` no longer writes to
  `ledger_entries` at all (ADR-0020), so it was never at risk of tripping
  this trigger — worth noting only because the two changes were introduced together
  and are easy to conflate (both now live in `001_schema.sql`).

## Related Files

- `migrations/001_schema.sql`
  (`enforce_ledger_entry_immutability`, `prevent_locked_ledger_entry_delete`)
- `src/services/ledger.service.js` (`updateEntry`, `deleteEntry`,
  `confirmProof`, `deleteProof` — the application-layer half of this rule)
- `src/services/dispute.service.js` (`raiseDispute`, `resolveDispute` —
  the only two RPCs allowed to move `status` on a locked entry)
