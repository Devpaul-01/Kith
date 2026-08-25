# ADR-0010: Postgres RPCs for Atomic Multi-Step Writes

**Status:** Accepted

## Context

Several operations in this domain require more than one write to remain
consistent: raising a dispute must insert a `disputes` row *and* flip the
related ledger entry's status in lockstep; accepting an invite must claim
the invite token *and* insert a new `workspace_members` row without a
window where two concurrent acceptances could both succeed; setting a
contributor's target amount touches multiple related rows. The Supabase
JS client issues each `.from(...).insert()/.update()` call as its own
independent request — there is no multi-statement client-side transaction
available through the query builder the way there would be with a raw SQL
client wrapping statements in `BEGIN`/`COMMIT`.

## Problem Statement

How do you guarantee that a multi-step write either fully succeeds or
fully fails — with no partial-write state visible to a concurrent
request — when the client library used for nearly everything else in the
codebase doesn't expose transactions directly?

## Decision

For operations where partial failure would leave inconsistent data,
delegate the entire multi-step write to a Postgres function invoked via
`supabaseAdmin.rpc(...)`, so the whole operation executes inside one
database-side transaction:

- `raise_dispute_atomic` / `resolve_dispute_atomic`
  (`dispute.service.js`) — insert the dispute and update the ledger
  entry's status together.
- `replace_user_contacts_atomic` (`auth.service.js#updateContacts`) —
  replaces what would otherwise be a separate delete-by-type followed by a
  batch upsert, closing the window where a failed upsert after a
  successful delete could lose contact methods with no rollback.
- `upsert_primary_contact` (`auth.service.js#upsertContact`) — runs the
  `is_primary=false` demotion and the upsert atomically, so two concurrent
  calls can't both end up with `is_primary=true` for the same contact
  type.
- `set_contributor_target_atomic` (`participant.service.js#setTarget`) —
  replaces three sequential, non-transactional writes with a single atomic
  operation.
- `convert_event_to_recurring_atomic`
  (`container.service.js#convertToRecurring`) — runs the container insert
  and participant upsert inside one Postgres transaction, so a failure
  partway through can't leave an orphan recurring container with no
  participants.
- `create_workspace_with_admin` (`workspace.service.js#createWorkspace`) —
  creating a workspace and its first admin membership row together.

Separately, `invite.service.js#acceptInvite` solves a related-but-distinct
problem — a *race*, not a multi-table consistency issue — with a
conditional atomic `UPDATE ... WHERE used_at IS NULL` rather than an RPC,
closing the double-accept race.

## Alternatives Considered

- **Sequential client-side calls with manual rollback on failure.**
  Rejected in favor of `replace_user_contacts_atomic` — compensating for a
  failure *after* a successful delete requires writing and testing
  rollback logic that Postgres's own transaction guarantees provide for
  free, and is easy to get wrong (e.g. forgetting an edge case in the
  rollback path).
- **Check-then-act with an application-level lock (e.g. Redis).** Not used
  for the invite-race case — a database-level conditional update
  (`WHERE used_at IS NULL`) achieves the same atomicity guarantee without
  introducing a second system (Redis) as a source of truth for something
  Postgres can already guarantee natively.
- **Accept eventual consistency / best-effort cleanup jobs for
  mismatches.** Not chosen for any of the flows above — all of them
  involve either financial state (ledger/dispute status) or membership
  state (contacts, workspace creation) where a background reconciliation
  job papering over a transient inconsistency was judged worse than paying
  the (small) cost of an RPC call.

## Rationale

The consistent thread across every RPC listed above is that each one
closes a specific, named failure mode — not "for safety" in the abstract,
but a concrete scenario (two concurrent calls both ending up with
`is_primary=true`, a failed upsert after a successful delete losing
contact methods, an orphan recurring container with no participants). Each
RPC was introduced in response to an identified, real race or
partial-failure risk rather than applied uniformly as a blanket policy —
ordinary single-table writes throughout the rest of the codebase (the
large majority of service functions) use plain `supabaseAdmin.from(...)`
calls without RPCs, because they don't have this multi-step consistency
requirement.

## Trade-offs

- Business logic for these specific operations is split across two
  languages and two places: JavaScript in the service file (validation,
  authorization checks, notification/audit orchestration around the RPC
  call) and SQL/PL-pgSQL inside the database function itself (the RPC
  bodies live in Supabase migrations, not the application source tree).
  This makes these particular flows harder to trace end-to-end from the
  application code alone compared to the RPC-free majority of the
  codebase.
- RPCs are Supabase/Postgres-specific, deepening the vendor coupling
  already discussed in ADR-0004 — these functions would need to be
  reimplemented as either raw transactions or application-level sagas if
  the database provider ever changed.

## Consequences

- The service-layer code calling each RPC stays relatively thin — it
  passes parameters in, gets a result back, and continues with
  notification/audit logic exactly as it would for any other service call
  — the atomicity guarantee is entirely encapsulated in the RPC rather than
  leaking into the calling service's control flow.
- Anyone adding a new multi-step write in this codebase has a clear,
  named precedent to follow (six examples across four different service
  files) for when to reach for an RPC instead of sequential calls, rather
  than needing to invent the pattern from scratch.

## Related Files

- `src/services/dispute.service.js` (`raiseDispute`, `resolveDispute`)
- `src/services/auth.service.js` (`updateContacts`, `upsertContact`)
- `src/services/participant.service.js` (`setTarget`)
- `src/services/container.service.js` (`convertToRecurring`)
- `src/services/workspace.service.js` (`createWorkspace`)
- `src/services/invite.service.js` (`acceptInvite` — conditional atomic
  UPDATE, the related-but-distinct race-closing pattern)
