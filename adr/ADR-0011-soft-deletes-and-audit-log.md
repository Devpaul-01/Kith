# ADR-0011: Soft Deletes with a Centralized Audit Log

**Status:** Accepted

## Context

The domain is explicitly a family financial-coordination platform —
ledger entries, disputes, contributions, member removals. Nearly every
entity (`workspaces`, `workspace_members`, `containers`, `groups`,
`milestones`, `container_tasks`, `users`) is queried with an `.is
('deleted_at', null)` filter throughout the service layer, and a separate,
append-only `audit_log` table records who did what to which resource.

## Problem Statement

In a domain involving money and family relationships, how do you support
"undo"/dispute-resolution workflows and preserve a defensible history of
who changed what, without either (a) losing data the moment someone clicks
delete, or (b) requiring every read query to reason about a separate
history table just to know current state?

## Decision

Two complementary, distinct mechanisms:

1. **Soft deletes via `deleted_at` timestamp columns.** Deletion sets
   `deleted_at = now()` rather than removing the row; nearly every read
   query filters `.is('deleted_at', null)`. Some entities go further and
   support *restoration* — `container.service.js#restoreContainer`
   explicitly clears `deleted_at` back to `null` (guarded by `.not
   ('deleted_at', 'is', null)` to ensure only genuinely soft-deleted rows
   are restorable). Hard deletes exist only where explicitly safe:
   `member.service.js#deleteMember` hard-deletes only when `force===
   'true'` *and* the member has zero confirmed ledger entries — otherwise
   it always soft-deletes, and explicitly throws if a hard delete is
   requested against a member with confirmed financial history ("Cannot
   hard-delete a member with confirmed ledger entries").
2. **A centralized, structured audit log** (`audit_log` table via
   `audit.service.js#log`) with a frozen action-name enum
   (`constants/audit-actions.js`'s `AUDIT_ACTIONS`) and a matching
   human-readable description map (`AUDIT_ACTION_DESCRIPTIONS`) kept in the
   same file so the two can never drift out of sync. `audit.service.js#log`
   is fire-and-forget — it never throws, only logs a warning on failure —
   so an audit-write failure never blocks the underlying business
   operation it's recording.

`constants/audit-actions.js` covers container lifecycle, groups, and
direct member creation with dedicated action constants
(`CONTAINER_CREATED`, the full set of `GROUP_*` actions, `MEMBER_CREATED`),
alongside the corresponding `audit.log()` call sites throughout the
relevant services — ensuring the activity feed and admin audit log have
full coverage for the highest trust-sensitivity actions in the app (who
created a savings pool, who added someone to a group, who marked a chore
done).

## Alternatives Considered

- **Hard deletes with a separate `deleted_items` archive table.** Would
  keep primary tables smaller, but every soft-delete flow in this codebase
  (container archival/restoration, member removal with financial-history
  protection) needs the *original row, in its original table, with its
  original relationships intact* — a separate archive table would break
  foreign-key joins used throughout the reporting/dashboard/audit-log
  queries.
- **Database triggers for audit logging instead of application-level
  calls.** Not used — every audit entry in this codebase is written
  explicitly from the service layer (`audit.log({ ...actorCtx, action,
  targetType, targetId, metadata })`) at the exact point the business
  operation completes, which lets each call site attach operation-specific
  metadata (e.g. `{ fields: Object.keys(updates) }` for a settings change)
  that a generic trigger firing on any table `UPDATE` couldn't easily
  infer.
- **Audit log as a side effect of soft-delete alone (deletion-only
  audit).** Rejected — the audit log covers far more than deletions
  (confirmations, invites, disputes, announcements, cycle overrides), by
  deliberate design rather than being scoped to just the deletion
  lifecycle.

## Rationale

The financial domain (ledger entries, disputes, corrections) is where the
soft-delete discipline is most visibly strict:
`ledger.service.js#deleteEntry` only permits deleting `pending` or
`proof_uploaded` entries — a *confirmed* entry cannot be deleted at all,
only corrected via `addCorrection`, which itself requires the *source*
entry to already be confirmed (non-confirmed entries can simply be edited
or deleted directly instead). This means confirmed financial state is, in
practice, append-only: it can be corrected by inserting a new correction
entry, never overwritten or removed. Soft deletes plus an audit trail are
what make this append-only guarantee auditable after the fact.

## Trade-offs

- Every read query across the codebase must remember the `.is
  ('deleted_at', null)` filter — there is no database-level enforcement
  (e.g. a view or RLS policy) that guarantees a forgotten filter is caught
  before it ships; it relies on consistent application-level discipline,
  the same category of care reflected elsewhere in the codebase (see the
  `bank_details`-selection and ILIKE-escaping decisions in ADR-0007 and
  `utils/ilike.js`).
- The audit log itself has no soft-delete or retention policy — it is
  intended to grow indefinitely, which the paginated/filterable/exportable
  `audit_log.service.js` (with a 10,000-row cap on CSV export) is built to
  handle.

## Consequences

- `describeAuditAction()` (in `constants/audit-actions.js`) provides
  metadata-aware description overrides (e.g. "changed {fields}" for a
  settings update, "added {N} participants" for a bulk add) rather than a
  single static string per action — this is only possible because the
  metadata passed to `audit.log()` at each call site is operation-specific,
  reinforcing why application-level (not trigger-based) logging was
  chosen.
- The dashboard's "recent activity" feed
  (`dashboard.service.js#getDashboardData`) and the dedicated audit-log
  endpoints (`audit_log.service.js`) both read from the same `audit_log`
  table with the same `describeAuditAction` helper, so the two surfaces
  can never present inconsistent descriptions of the same event.

## Related Files

- `src/constants/audit-actions.js`
- `src/services/audit.service.js`
- `src/services/audit_log.service.js`
- `src/services/ledger.service.js` (`deleteEntry`, `addCorrection` —
  strictest soft-delete/append-only enforcement)
- `src/services/member.service.js` (`deleteMember` — conditional hard vs.
  soft delete)
- `src/services/container.service.js` (`deleteContainer`,
  `restoreContainer`)
