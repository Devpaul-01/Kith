# Ranked search extension proposal

Status: ready for a schema decision; not applied to `migrations/001_schema.sql`.

The remaining Tier 0 tools need the same ranked PostgreSQL search already
used by `find_member` and `find_container`. This proposal adds four read-only
RPCs and four indexes to the consolidated schema. It reuses the installed
`pg_trgm` extension, `search.service.js`, `containsPattern()`, and the existing
candidate/disambiguation contract. It introduces no tables or dependencies.

## Functions and permissions

| Tool | RPC | Member visibility | Admin visibility |
| --- | --- | --- | --- |
| `find_tasks` | `search_tasks_ranked` | Tasks assigned to the caller | Tasks in the current workspace |
| `find_ledger_entries` | `search_ledger_entries_ranked` | Entries whose contributor is the caller | Entries in the current workspace |
| `find_disputes` | `search_disputes_ranked` | Disputes raised by the caller | Disputes in the current workspace |
| `find_group` | `search_groups_ranked` | Group directory metadata | Group directory metadata |

All handlers explicitly require active membership before calling the search
service. Workspace/caller IDs and the real admin flag come only from server
context. Strict model argument schemas cannot override them. Group search
follows the member-visible list route; `get_group` remains admin-only.

Tasks and ledger entries must belong to a non-deleted container in the
authenticated workspace. Tasks must also be non-deleted. Ledger rows must
match the workspace both directly and through their parent container.
Dispute search follows `get_dispute`: it can find historical disputes even
when a related container has been deleted. Joined member/ledger rows are
scoped to the same workspace. All searches exclude deleted workspaces.

For the three private-data RPCs, a scoped lookup of the caller's current
membership additionally requires `is_active = true` and `deleted_at IS NULL`.
The SQL admin branch requires both the server-supplied admin flag and an
actual `admin` role on that membership. Missing/inactive/mismatched membership
returns no candidates. This is an explicit query boundary; it does not rely
on RLS.

Proposed signatures:

```sql
search_tasks_ranked(
  p_workspace_id uuid, p_caller_id uuid, p_is_admin boolean,
  p_query text, p_pattern text, p_limit integer DEFAULT 11,
  p_container_id uuid DEFAULT NULL
)

search_ledger_entries_ranked(
  p_workspace_id uuid, p_caller_id uuid, p_is_admin boolean,
  p_query text, p_pattern text, p_limit integer DEFAULT 11,
  p_container_id uuid DEFAULT NULL
)

search_disputes_ranked(
  p_workspace_id uuid, p_caller_id uuid, p_is_admin boolean,
  p_query text, p_pattern text, p_limit integer DEFAULT 11
)

search_groups_ranked(
  p_workspace_id uuid, p_query text, p_pattern text,
  p_limit integer DEFAULT 11
)
```

Functions use `LANGUAGE sql STABLE SECURITY INVOKER`, the existing pinned
`pg_catalog, public, extensions, pg_temp` search path and a word-similarity
threshold of `0.3`. Execution is revoked from `PUBLIC`, `anon` and
`authenticated`, and granted to `service_role` when that role exists, matching
the current ranked-search RPCs. Handlers remain the required authorization
boundary before these service calls.

## Matching and returned fields

- Tasks: match the title. Candidates contain ID, container ID, title,
  assignee membership ID, stored status and due date.
- Ledger entries: match note text, contributor name, or an exact original
  amount. A plain signed decimal query is compared as PostgreSQL `numeric`;
  no currency conversion, summation or natural-language amount inference is
  performed. Different currencies can produce separate candidates. Return
  ID, container ID, contributor membership ID/name, note, original amount as
  decimal text, original currency, entry type, stored status and recorded time.
- Disputes: match the reason, raiser name or linked ledger note. Return ID,
  linked entry ID, raiser membership ID/name, reason, stored status and raised
  time. Notes arrays, proofs and internal ledger fields are not returned.
- Groups: match the name. Return ID, name, description and creation time.

Every candidate also includes the database `match_type` (`exact`, `substring`
or `fuzzy`) and original `score`. Rank exact matches first, then escaped
literal substring matches, then trigram matches; break ties by score, stable
text ordering and ID. Trigram matching requires at least three query
characters, matching the current search functions.

Model queries are trimmed and limited to 2–200 characters. Display limits
are 2–20 with a default of 10; SQL allows at most 21 rows so the service can
detect `has_more`. Optional `container_id` filters are supported for task and
ledger searches. The service returns `not_found`, `single_match` or
`ambiguous` before truncating the candidate list. It never selects a resolved
ID or treats an exact first result as proof of uniqueness.

All returned names, notes, reasons and descriptions remain untrusted tool
data. Query failures return `SEARCH_UNAVAILABLE`, never a fabricated
no-match result. No export or write action is added by this extension.

## Indexes and insertion point

Add these indexes with the new functions after the `disputes` table and its
indexes, where all referenced tables exist:

```sql
CREATE INDEX idx_tasks_title_trgm ON public.container_tasks
  USING gin (title gin_trgm_ops) WHERE (deleted_at IS NULL);

CREATE INDEX idx_ledger_note_trgm ON public.ledger_entries
  USING gin (note gin_trgm_ops) WHERE (note IS NOT NULL);

CREATE INDEX idx_disputes_reason_trgm ON public.disputes
  USING gin (reason gin_trgm_ops);

CREATE INDEX idx_groups_name_trgm ON public.groups
  USING gin (name gin_trgm_ops);
```

Contributor/raiser names reuse the existing member-name trigram index where
the planner can use it; no duplicate member index is proposed. The consolidated
schema remains the sole schema source, with no incremental migration runner.

## Implementation and validation after the decision

Extend `search.service.js` without changing existing search method contracts,
add strict tool/request validators, and register the four Tier 0 handlers.
Unit tests cover role/context rejection, the real caller passed to each RPC,
amount preservation, field trimming, ambiguous results, lookahead, query
failures and hostile text. Existing chat/provider tool-list tests are updated.

Add real database cases beside `tests/integration/database/ranked-search.test.js`
for typo ranking, literal wildcard escaping, exact decimal matching, other
workspaces, private ownership boundaries, stale admin flags, deleted records,
optional container filters, RPC grants and bounded results. These integration
tests require the local Postgres/Redis/PostgREST stack and remain pending until
that stack is available; unit mocks cannot verify SQL authorization or plans.
