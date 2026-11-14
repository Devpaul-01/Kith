# Agent tools

This module currently provides read tools through `getAvailableTools(context)`
and `executeReadTool({ name, args, context })`. Server code must build context
after the existing auth and membership middleware:

```js
const context = { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId };
```

The registry includes all seven Tier 0 tools and all 28 Tier 1 tool names
from the architecture, with the role restrictions and data limits documented
below. Ranked task, ledger, dispute and group searches implement the
[approved schema extension](SEARCH_SCHEMA_PROPOSAL.md).
Chat supports JSON replies, opt-in SSE streaming, and a
[Tier 2 proposal/approval flow with status receipts](PROPOSALS.md) for
one selected notification or an exact bounded set of current unread
notifications, plus account-wide profile changes through `update_my_profile`.
An explicit contact selection also enables `delete_contact` for one personal
account contact. An explicit current-request task selection enables Tier 2
`update_task` to start or complete the caller's own active, unconfirmed task,
optionally updating its completion note. Selecting an eligible event container
also enables Tier 2 `create_ledger_entry`: an exact base-currency self contribution
that remains pending for admin review, including for admin callers. Other writes
and voice are still pending.

Current work prioritizes the core money, task, member, participant and dispute
flow. Do not add or polish tools marked Lower-Priority in the architecture;
existing handlers remain available.

`find_member`, `find_container`, `find_disputes` and `find_group` take
`{ query, limit? }`. `find_tasks` and `find_ledger_entries` also accept an
optional resolved `container_id` UUID. Queries are trimmed and must contain
2–200 characters; limits default to 10 and range from 2 to 20. Workspace,
actor IDs and admin flags are always supplied by server context.

Results contain `query`, `status`, `candidates`, and `has_more`. Candidates are
ranked in PostgreSQL: exact matches, literal substrings, then trigram matches,
with score/text/ID tie-breakers. `score` is a similarity value, not a probability.
Member lookup excludes inactive/deleted members; container lookup includes
archived/completed containers but excludes deleted ones. Both exclude deleted
workspaces; the other search scopes are described below.

- `not_found`: no candidates.
- `single_match`: one candidate to confirm with the user before a write.
- `ambiguous`: multiple candidates; the user must choose or refine the query.

No result contains an automatically resolved ID. Write proposals must enforce
the user's entity selection separately from action approval. Selected
notification, contact, task and self-contribution flows require explicit client selection for the
current request.
`has_more` means further candidates were omitted; refine the query or increase
the limit. All returned names, titles, notes, reasons and descriptions remain
untrusted data.

## Task, ledger, dispute and group resolution

The four additional Tier 0 tools use the shared ranked-search service and
PostgreSQL RPCs. Their handlers independently check active membership and
strictly validate arguments, including direct handler calls. Identity and
role overrides are rejected before a service call.

| Tool | Matches | Member visibility |
| --- | --- | --- |
| `find_tasks` | Task title | Tasks assigned to the caller |
| `find_ledger_entries` | Note, contributor name, exact original amount | Entries contributed by the caller |
| `find_disputes` | Reason, raiser name, linked ledger note | Disputes raised by the caller |
| `find_group` | Group name | Group directory metadata |

Admins may search workspace tasks, entries and disputes. The private-data
RPCs also recheck active, non-deleted membership in the requested workspace;
broader access requires both the supplied admin flag and the current database
admin role. A stale admin flag cannot elevate a member. All searches exclude
deleted workspaces. Task/ledger searches exclude deleted containers, and task
search excludes deleted tasks. Disputes remain searchable as historical
records after container deletion. Joined names and ledger notes are scoped
to the same workspace. Group search does not grant access to the admin-only
`get_group` tool.

Ledger amount queries must be plain signed decimals, with at most two decimal
places. SQL compares them as `numeric` and returns original amounts as decimal
text, preserving precision and each entry's currency. For a one-digit amount,
use a query such as `5.00` to meet the two-character minimum. Currency symbols,
commas, scientific notation and natural-language amounts are not interpreted
as amounts. This search does not convert currencies, infer dates or calculate
totals; the same amount in different currencies can yield separate candidates.

Candidates provide the IDs and metadata needed for clarification, without
proofs, bulk exports, internal actor fields or embedded membership/note arrays.
Use selected task/entry IDs and their container IDs with `get_task` or
`get_ledger_entry`; use a selected dispute ID with `get_dispute`. Exact matches
still remain ambiguous when other candidates exist. Failures return
`SEARCH_UNAVAILABLE`, not a false no-match. The read loop keeps results in
untrusted-data envelopes and prevents direct write execution and bulk exports.

## Container browsing

`list_containers` and `get_container` are Tier 1 reads available to active
members and admins, matching the existing container HTTP routes. Both use
the authenticated workspace and exclude deleted containers. Handlers check
membership themselves; model arguments cannot change identity, include
deleted records, or select a broader service view.

Lists accept optional `type` (`event` or `recurring`), stored `status`
(`active`, `completed`, or `archived`), and `sort` (`created_at`, `name`, or
`event_date`, with an optional leading `-` for descending order). The default
is ascending creation date with an ID tie-breaker. `page` ranges from 1 to
10,000 and `per_page` from 1 to 100 (defaults: 1 and 20). Filtered totals and
`next_page` come from the server; the model must not count list rows. A null
next page means the end of the results or the page limit.

List results contain identity/type/status, subtitle, task/money enablement,
stored event/recurrence dates, and lifecycle timestamps. `get_container`
accepts only a resolved `container_id` UUID and adds description, event type,
recurrence settings, the stored budget target/currency, completion notes,
and the source container ID after a conversion. Budget targets are settings,
not collected/remaining balances; the agent must not calculate totals or
future billing dates. Use `get_container_summary` for permitted financial
and participant summaries and `list_cycles` for admin billing schedules.

Use `find_container` for names and clarify ambiguous matches. A partial list
cannot establish that a name is unique. All user-written text remains in the
untrusted-data envelope. Neither tool exposes public-link tokens, files,
ledger rows, participant/cycle records, or internal actor fields.

The existing container service supports internal paginated metadata lists
and a `metadataOnly` detail view, avoiding those unrelated joins and reads.
Existing HTTP callers keep their unpaginated list/detail envelopes. Failed
base queries, unavailable list rows, and invalid exact counts return typed
`CONTAINERS_UNAVAILABLE` errors instead of zero/empty results. A missing
container remains `NOT_FOUND`; chat maps failed reads to `AGENT_TOOL_FAILED`.
Unit and mocked HTTP tests cover scope, field trimming, pagination, errors,
and clarification/hostile-text turns. Live database/model validation remains
pending.

## Container and ledger summaries

`get_container_summary` and `get_ledger_summary` are Tier 1 reads available
to active workspace members and admins. Both accept only
`{ "container_id": "<uuid>" }`. Resolve names with `find_container`; ambiguous
matches should prompt a clarification. Workspace, caller, and role always
come from authenticated context, including when handlers are called directly.

The container tool wraps `container.service.getSummary` and preserves its
field trimming: members see their own financial details and a reduced status
view for other participants. Its member-view financial totals include only
the caller's visible amounts. Admins receive all participants' financial
details. Target totals use current non-cycle targets; they do not summarize
a specific recurring billing cycle.

The ledger tool wraps `ledger.service.getLedgerSummary`: admins see all
entries in the container; members see only their own. Counts and base-currency
totals cover all dates and cycles. Date/cycle filters are not supported and
are rejected instead of silently ignored. Before querying totals, the handler
uses `container.service.getContainer` to verify a non-deleted container in the
authenticated workspace. That lookup's broader details are discarded.

Both tools return the existing service values without recalculating amounts
or counts. Summary text remains untrusted tool data. Unit tests exercise the
handlers and real domain services with mocked Supabase responses, plus
scripted resolution/clarification turns. Actual database isolation and
live-model numerical accuracy still need integration/evaluation coverage.

## Member directory

`list_members` and `get_member` are Tier 1 directory reads available to active
members and admins, including when reading another member or a proxy. Both
handlers check the caller's membership and pass the real workspace and role
to the existing member service. A role returned by a tool or used as a list
filter never grants the caller that role.

Lists accept optional `role` (`member` or `admin`), boolean `is_proxy` and
`is_active`, and a trimmed 2–200 character `search` string. Search uses the
service's escaped literal display-name substring matching. Use `find_member`
for ranked active-member matches, including typos. Inactive members remain
reachable through `list_members`; deleted memberships are always excluded.
When no status filters are supplied, both active/inactive and proxy/non-proxy
members are included.

Sort by `display_name` (the default) or `joined_at`, with a leading `-` for
descending order and an ID tie-breaker. `page` is bounded to 1–10,000 and
`per_page` to 1–100 (defaults: 1 and 20). The service supplies an exact total
for all matching rows, independent of the current page. Use `next_page` to
continue; null means the last page or the page limit. The model must not
count rows or infer that a name on a partial page is unique.

`get_member` accepts only `member_id`, a resolved UUID. Both tools return
display name, role, proxy/active flags, proxy manager ID, family relationship,
and membership timestamps. Contact details, birth dates, user-account IDs,
admin notes, storage URLs, and financial/activity fields are omitted even
for admins. Reading a proxy or its manager does not authorize acting on
their behalf. Resolve ambiguous names through clarification; all text stays
inside the untrusted-data envelope.

The service uses internal paginated directory lists and a `metadataOnly`
detail view to avoid profile joins and unrelated aggregate reads. Existing
HTTP list/detail callers keep their response shapes and role trimming.
Failed base queries, missing list rows, and unavailable exact counts raise
`MEMBERS_UNAVAILABLE`; missing targets remain `NOT_FOUND`. Chat maps failed
reads to `AGENT_TOOL_FAILED`. Unit and mocked HTTP tests cover these boundaries,
filters, pagination, clarification, and hostile text. Live database/model
validation remains pending.

## Member contribution summaries

`get_member_contribution_summary` is a Tier 1 read accepting only
`{ "member_id": "<uuid>" }`. Use `find_member` for names and ask the user to
choose or refine ambiguous matches. For the caller's own summary, use the
member ID returned by `get_my_context`.

Any active workspace member or admin may read another member's contribution
summary within the same workspace, matching the existing member-summary HTTP
route. The handler checks authenticated membership, then uses
`member.service.getMember` with the real workspace and role to verify that the
target member exists and is not deleted. Profile details from that lookup are
discarded. Only `member.service.getContributionSummary` results reach the model.

The result preserves the service's calculations and field types:

- `total_containers` counts distinct containers represented in ledger entries.
- `total_confirmed_count` and `total_paid_base_currency` include confirmed and
  resolved entries across all dates and cycles.
- `last_contribution_date` comes from those entries' confirmation dates.
- `containers` contains participation summaries using current non-cycle
  targets, retaining each target's amount and currency.

Date, container, and cycle filters are unsupported and rejected. These totals
cannot answer a request specifically for this month's contributions. The
agent must report that limitation and must not calculate a filtered total or
convert target currencies itself.

The shared service now scopes ledger reads by workspace and uses an inner
container join to exclude participations outside that workspace. Failed queries
or results without a row array raise `MEMBER_SUMMARY_UNAVAILABLE` (503) instead of
producing a partial or zero summary; the chat loop returns its existing
`AGENT_TOOL_FAILED` response without asking the model to narrate a result.

Unit tests cover handler permissions, workspace/target lookup, query filters,
service calculations and errors, argument validation, and scripted
resolution/clarification turns. Real database isolation and join behavior,
plus live-model disambiguation and numerical fidelity, still need integration
and evaluation coverage.

## Member engagement

`get_member_engagement` is an admin-only Tier 1 read accepting `{}`. The registry
omits it for members, and the handler separately checks active admin membership
before calling `member.service.getMemberEngagement`. Identity and workspace
come from authenticated context; member, date, container, and other filters
are rejected.

The tool returns non-deleted, non-proxy members, including deactivated
memberships, matching the existing engagement endpoint. Each row includes
`member_id`, `display_name`, `last_activity`, `confirmed_contributions_count`,
`pending_contributions_count`, and `engagement_level`. The service computes
activity from the latest stored member activity, confirmed/resolved ledger
confirmation, or completed task. Its classifications are `active` within
30 days, `quiet` within 90 days, and `inactive` otherwise, including no recorded
activity. These describe activity, not whether a membership is enabled.

Counts cover all dates. Confirmed counts include resolved entries; pending
counts include only `pending` entries and exclude `proof_uploaded`. The tool
preserves these existing definitions and values. The service's legacy
`overdue_count: 0` placeholder is omitted from agent results. Use
`get_overdue_summary` for overdue contributions and `get_dashboard` for
workspace counts of quiet/inactive members; the model must not count rows.

Member engagement reads scope the member list, ledger entries, and completed
tasks to the workspace; tasks are scoped through an inner container join.
The shared activity helper retains its existing batch mode for callers that
scan member IDs across workspaces. Failed queries or missing/non-array data
raise `ENGAGEMENT_UNAVAILABLE` (503) instead of producing partial counts or
classifications. This failure handling also applies to the helper's dashboard
and background-job callers. The chat loop returns `AGENT_TOOL_FAILED` on a
service failure.

Unit and HTTP tests exercise permissions, query scope, service calculations,
field trimming, and untrusted member names. Real database join/isolation checks
and live-model evaluation remain pending.

## Billing cycle lists

`list_cycles` is an admin-only Tier 1 read, matching the existing cycles HTTP
route. It accepts a required `container_id` UUID, optional `status`
(`upcoming`, `open`, `closed`, or `skipped`), `page` (1–10,000, default 1), and
`per_page` (1–100, default 20). Use `find_container` for names; ask the user to
choose or refine ambiguous matches. The handler checks active admin membership
even when called directly, and rejects workspace/role overrides and unsupported
filters.

The shared container service now checks that the container belongs to the
requested workspace and is not deleted before reading its cycles. The existing
HTTP controller also supplies that workspace, closing the same gap for direct
cycle-list requests. An unavailable parent returns `NOT_FOUND`; failed queries
or invalid row/count results return `CYCLES_UNAVAILABLE` (503). The chat loop
maps service failures to its existing `AGENT_TOOL_FAILED` response.

Results contain `cycles` in descending `cycle_number` order and a `pagination`
object with `page`, `per_page`, `total`, `total_pages`, and `next_page`. Counts
apply to the optional status filter across all pages. Pagination metadata uses
the same utility as HTTP responses; the server also supplies `next_page`, so
the model does not calculate it. It is null on the last page or at page 10,000;
refine the status filter when the page limit is reached. An empty page can
mean that the requested page is past the end, so consult `pagination.total`.

Each cycle exposes only its ID, container ID, sequence number, start/end dates,
stored status, creation timestamp, and closure timestamp. The legacy
`total_expected` and `total_collected` columns are not maintained by the current
generation/lifecycle jobs and are omitted from agent results. This tool cannot
answer cycle-specific financial totals or generate, override, open, or close
cycles. All returned values remain untrusted data.

Unit and HTTP tests cover permissions, workspace scope, filtering, pagination,
field trimming, and scripted resolution/clarification. Real database isolation
and live-model evaluation remain pending.

## Task reads

`list_tasks` and `get_task` are Tier 1 reads for active workspace members and
admins, wrapping the existing task service. Members see only tasks assigned
to their own authenticated membership. Admins may read all tasks in the
container, including unassigned tasks. Both handlers check membership even
when called directly; caller, role, and workspace cannot come from arguments.

`list_tasks` accepts a required `container_id` UUID, optional `assigned_to`
UUID and `status` (`pending`, `in_progress`, `completed`, `overdue`, or
`cancelled`), `page` (1–10,000, default 1), and `per_page` (1–100, default 20).
Members requesting another assignee are denied before the service is called.
`get_task` accepts only `container_id` and `task_id` UUIDs and returns `{ task }`.
Date, title-search, sorting, and other unsupported arguments are rejected.

Use `find_container` for container names and `find_member` for an admin's
assignee filter. `find_tasks` resolves task titles across the workspace or
within a selected container; `list_tasks` also supplies IDs for browsing.
Ask the user to choose or refine ambiguous names or task titles. A partial
page cannot establish that a title is unique across the container.

List results contain `tasks` in ascending stored `sort_order`, with ID as a
stable tie-breaker. The `pagination` object supplies `page`, `per_page`,
`total`, `total_pages`, and `next_page` through the shared pagination utility.
Totals count only visible tasks matching the requested filters across all
pages; the model must not count the returned rows. `next_page` is null on the
last page or at page 10,000. Refine the filters at the page limit; an empty
page past the end is not evidence of an empty container. Status is the stored
value, not recalculated from the due date by the agent.

Both tools expose only task/container IDs, title, description, assignee ID
and display name, due date, status, completion timestamp and note, admin
confirmation timestamp, and creation/update timestamps. Proof files, storage
paths, admin notes, and internal actor/sort fields are omitted. All text
remains in the read loop's untrusted-data envelope. Task writes, proof actions,
and exports are unavailable through these tools.

The shared list/detail service verifies that the non-deleted parent container
belongs to the workspace before querying tasks. Both existing HTTP controllers
now supply the routed workspace. The HTTP task list keeps its existing full
array and field shape; only callers opting into internal pagination receive
`{ tasks, count }`. Missing parents/tasks return `NOT_FOUND`, and a member
reading someone else's task receives `FORBIDDEN`. Query failures, unavailable
list rows, and invalid exact counts raise `TASKS_UNAVAILABLE` (503). The shared
single-task fetch also rejects query errors before existing update/proof
callers can continue. Chat maps unavailable reads to `AGENT_TOOL_FAILED` and
preserves permission denials.

Unit and HTTP tests cover workspace scope, member/admin visibility, filters,
pagination, field trimming, service failures, and scripted clarification and
hostile-text cases. Actual Postgres isolation and live-model disambiguation
and prompt-injection behavior still require integration/evaluation coverage.

## Ledger entry reads

`list_ledger_entries` and `get_ledger_entry` are Tier 1 reads. Members see only
their own contributor entries; admins see all entries in the container. The
handlers check active membership and pass the real workspace, member, and
role. A member's filter targeting another contributor is rejected up front.

Lists accept `container_id`, optional `contributor_id`, stored `status`,
inclusive `from`/`to` timestamps on `recorded_at`, and the usual `page`
(1–10,000) / `per_page` (1–100) arguments. Timestamps require a timezone and
must be ordered; dates without times are rejected. Default order is newest
first, with an ID tie-breaker. Pagination counts the visible filtered entries
and supplies `next_page`. This is not a filtered financial-total tool; the
model must not sum entries or convert currencies. Cycle filters are not
supported. Entry details accept only `container_id` and `entry_id`.

Resolve container and contributor names with their search tools. Use
`find_ledger_entries` for ranked entry lookup by note, contributor or exact
original amount, or use list results for entry IDs. Clarify ambiguous entries;
a partial page cannot establish uniqueness. Both tools return stored amounts verbatim and
identify the authenticated workspace's base currency. Proof files, storage
paths, idempotency keys, and internal recorder/confirmer fields are omitted.
Notes remain untrusted data. No confirmation, correction, export, or write
operation is exposed by these tools.

The shared list/detail service checks the non-deleted workspace container;
entry detail now also filters by workspace, supplied by its HTTP controller.
Query failures, missing list arrays, and invalid exact counts raise
`LEDGER_UNAVAILABLE` instead of reporting empty or zero results. Existing
HTTP field/envelope contracts are retained. Unit and mocked HTTP tests cover
scope, ownership, filters, precision, errors, and hostile content. Live
database isolation and model evaluation remain pending.

## Notification reads

`list_notifications` and `get_unread_count` read only the caller's own inbox
in the authenticated workspace, including for admins. Both handlers check
membership, reject recipient/workspace overrides, and wrap the existing
notification inbox service. Listing accepts optional boolean `is_read`,
`page` (1–10,000), and `per_page` (1–100). Counting accepts only `{}`.

Lists return permitted notification text/reference fields and read timestamps,
omitting delivery internals and deduplication keys. Results include filtered
pagination with `next_page`; `unread_count` covers all unread notifications in
this workspace, independent of the list filter or page. Reading does not mark
anything as read. Notification titles/bodies remain untrusted tool content.

The inbox service now applies the same recipient/workspace scope to the list
and unread counter, uses stable creation-date/ID ordering, and rejects query
failures or unavailable counts with `NOTIFICATIONS_UNAVAILABLE`. Existing
HTTP read controllers use the workspace from the resolved membership and
keep their existing response envelopes. Mocked service, tool, loop, and HTTP
tests cover these boundaries; live database/model verification remains pending.

## Group reads

`list_groups({ search?, page?, per_page? })` is a Tier 1 read available to
members and admins. It returns group metadata (ID, name, description and
timestamps) and an exact filtered group count. Search is an escaped literal
name substring, 2–200 characters; it does not resolve spelling errors. Groups
are ordered by name then ID. Embedded memberships and membership counts are
omitted from this list.

`get_group({ group_id, page?, per_page? })` is **admin-only**, matching the
existing group-detail HTTP route. It returns group metadata, a bounded page
of membership directory fields and an exact membership count. Both the group
and the joined memberships are scoped to the authenticated workspace. Deleted
members are excluded; proxies and inactive memberships remain visible.
Members are ordered by added timestamp then group-membership ID. No contact
information, actor IDs, or financial details are exposed.

Both tools use pages 1–10,000 and 1–100 rows per page (defaults 1/20), with
`pagination.next_page` null at the last page or page limit. Group detail
pagination describes memberships, while list pagination describes groups.
Use the service count; never infer totals or name uniqueness from page length.
Use `find_group` for ranked group-name lookup, including typos. Duplicate
group names require clarification. Descriptions and relationship
text remain in untrusted tool-result envelopes. Missing groups return
`NOT_FOUND`; failed queries or unavailable exact counts return
`GROUPS_UNAVAILABLE`. Internal pagination options preserve the legacy HTTP
response shapes. Live PostgREST join/count validation remains pending.

## Dispute reads

`list_disputes({ status?, page?, per_page? })` is admin-only. It lists disputes
by newest raised timestamp then ID, with an optional `open`/`resolved` filter.
The exact count covers matching disputes, including those whose linked entry
is unavailable. Results include stored entry amounts but omit embedded notes.

`get_dispute({ dispute_id, page?, per_page? })` is available to admins and to
the member who raised that dispute. The handler checks membership, forwards
the real caller and role, and verifies ownership before returning the result.
The service checks ownership before reading the linked entry. Every parent
and related-record lookup stays in the authenticated workspace. A missing
linked entry is `null`; a failed query is an error.

Detail pagination applies to notes in stored append order, using
`notes_pagination`; its total is the service-counted length of the stored
notes array. Both tools default to page 1/20, allow pages 1–10,000 and 1–100
rows per page, and return a null `next_page` at the last page or page limit.
Smaller pages may be needed for long text to fit the shared tool-result limit.
Use `find_disputes` to resolve reasons, raiser names or linked ledger notes;
IDs can also come from notifications or an admin dispute list. Ambiguous
references need clarification. Reasons, resolutions, notes and linked-entry
text remain untrusted data. Stored monetary precision/currency is preserved, with the
workspace base currency supplied by server context. No proof paths,
idempotency keys, or dispute writes are exposed.

Internal metadata and note-pagination options preserve legacy HTTP response
shapes. Failed queries, invalid list counts or malformed notes fail with
`DISPUTES_UNAVAILABLE`. Unit coverage includes the ownership and workspace
boundaries; live PostgREST join validation remains pending.

## Invite and audit reads

`list_invites({ status?, page?, per_page? })` is admin-only. It returns invite
IDs, inviter directory names/IDs, stored timestamps, service-evaluated status
and an exact filtered count. Optional status is `available`, `used` or
`expired`. The service uses one `as_of` timestamp for filtering and status;
used takes precedence over expiry, and the expiry boundary matches the
existing preview service. Revoked invites are deleted and absent from results.
Invite tokens, URLs and recipient account IDs are excluded. This read cannot
create, accept, revoke or send an invite.

`get_audit_log({ action?, actor_member_id?, from?, to?, page?, per_page? })`
is admin-only. Action filters come from the frozen `AUDIT_ACTIONS` catalog;
actor filtering uses a resolved membership ID and never changes the caller.
Date bounds are inclusive ISO timestamps with explicit timezones. Results
contain only event IDs/actions, actor membership IDs/names, target types/IDs
and timestamps. An unavailable actor display name is `null`; it must not be
used to infer a person or attribute an event to System. Raw audit metadata,
account IDs, IP addresses and user-agent fields are excluded. CSV export
remains outside the registry.

Both tools use newest timestamp then ID ordering, default page 1/20, pages
1–10,000 and 1–100 rows per page. Exact counts cover the requested filters;
`next_page` is null at the last page or page limit. Service failures and invalid
counts return `INVITES_UNAVAILABLE` or `AUDIT_LOG_UNAVAILABLE`. Names remain
untrusted data. Internal service options retain legacy HTTP response shapes.
Unit coverage verifies role checks, field trimming, filtering, expiry states,
count failures and prompt-injection handling. Live join/count validation is
still pending.

## Participant and target reads

`list_participants({ container_id, page?, per_page? })`,
`get_target_history({ container_id, participant_id, page?, per_page? })` and
`get_cycle_targets({ container_id, participant_id, page?, per_page? })` are
all admin-only, matching the nested participant HTTP routes. Each handler
enforces that gate before calling the participant service, which trusts its
caller. Model arguments cannot supply identity, role or internal service
options. Container and participant lookups verify the authenticated workspace
and exclude deleted containers/memberships; proxies and inactive memberships
remain visible.

The participant list includes directory/tracking fields and the stored current
non-cycle target, ordered by added timestamp then participant ID. The exact
count describes visible participants. Only current targets for that page are
fetched; missing targets have no invented zero amount. Participant notes and
internal actor/public-visibility fields are excluded.

Target history includes cycle and non-cycle versions, original amount/currency,
current and supersession state, and setter directory IDs/names. It is ordered
by newest set timestamp then target ID; its count describes matching versions.
Use the participant **record ID** from `list_participants`, not the distinct
`workspace_member_id`. Duplicate names require clarification.

Cycle-target pages are ordered by cycle number and include every returned
cycle, with its current stored target or `null`. Their exact count describes
cycles. They return stored schedule and original-currency target fields only.
The legacy service compares base-currency payments to original-currency
targets and sums an unbounded ledger query; those payment totals and
classifications are omitted from agent results. A null target does not establish
skipped/paid/overdue participant status. Existing summary tools retain their
documented financial scopes.

Defaults are page 1/20, with pages 1–10,000 and 1–100 rows per page. All results
include bounded `next_page` continuation. Failed reads, invalid counts or
duplicate/mismatched current targets return `PARTICIPANTS_UNAVAILABLE`;
missing scoped resources return `NOT_FOUND`. Untrusted labels/setter names
stay in tool-result envelopes. Opt-in pagination preserves legacy HTTP behavior.
Unit coverage verifies role/scoping branches, monetary preservation, count
failures, duplicate-name clarification and exclusion of writes. Live PostgREST
join/count validation remains pending.

## Timeline and milestone reads

`get_timeline({ limit?, cursor? })` and `get_milestone({ milestone_id })` are
available to active members and admins. Both use the authenticated workspace
and exclude deleted records. Timeline items contain milestone metadata and
dated container completions; file paths/photos are excluded. The timeline
limit defaults to 20 and ranges from 1 to 100. It provides continuation and
has no workspace total count.

To continue, copy the complete returned `next_cursor` object into `cursor`:

```json
{
  "limit": 20,
  "cursor": {
    "before_container": { "date": "2026-11-01T12:00:00.000Z", "id": "11111111-1111-4111-8111-111111111111" },
    "before_milestone": null
  }
}
```

Both source keys are required when a cursor is supplied. Container cursor
dates are ISO timestamps with explicit timezones; milestone cursor dates are
`YYYY-MM-DD`. IDs are UUIDs. Null source cursors mean that source has not
advanced. Sources are ordered by descending date and ascending ID; merged
items preserve source ordering, including sub-millisecond completion dates.
Container completions precede milestones at equal instants. Each source uses
one lookahead row, and cursors advance only past items actually returned.
Date-and-ID cursors prevent same-date events from being skipped. At the end,
`has_more` is false and `next_cursor` is null.

Milestone details contain title, description, date, type and timestamps.
Use timeline `reference_type`/`reference_id` to choose `get_milestone` or
`get_container`, and clarify duplicate titles. User text stays untrusted.
Strict cursor schemas prevent raw filter expressions from reaching the query.
Failed timeline reads return `TIMELINE_UNAVAILABLE`; detail read failures
return `MILESTONES_UNAVAILABLE`, and missing milestones return `NOT_FOUND`.
The internal metadata path preserves legacy HTTP timeline cursor/response
shapes. Unit tests cover role checks, fields, duplicate-title clarification,
same-date continuation, source exhaustion and hostile text. Live pagination
validation remains pending.

## Chat endpoint

`POST /v1/workspaces/:workspaceId/agent/chat` accepts a bearer token and a JSON
body containing a nonempty `message` (up to 8,000 characters), with an optional
`conversation_id` as described below. The
[Tier 2 proposal flow](PROPOSALS.md) can propose marking all current unread
notifications read or updating the caller's account profile. An optional
`selected_notification_id` additionally enables the single-notification proposal.

`selected_contact_id` instead enables deletion of that exact caller-owned
account contact. Each selection applies only to the current request; IDs in
prose and conversation history do not select a target. See the
[contact deletion contract](PROPOSALS.md#contact-deletion).

For example, a dashboard read needs only a message:

```json
{ "message": "Show my workspace dashboard." }
```

By default, the endpoint returns one complete JSON response using the existing
API envelope. For example, after a dashboard read:

```json
{
  "data": {
    "text": "Here is your workspace dashboard.",
    "modelCalls": 2,
    "toolCalls": 2
  }
}
```

`modelCalls` and `toolCalls` are server-counted turn metrics; the initial
context read is included in `toolCalls`. Successful replies use
`Cache-Control: no-store`. Omitting `conversation_id` keeps the existing
stateless behavior and response shape. Request SSE explicitly as described
under Streaming chat below.

The route inherits `requireAuth` → `loadDbUser` → `requireMembership` from the
workspace router. Context comes exclusively from those middleware results.
Client-supplied history, roles, tools, identity fields, model settings, and
workspace IDs in the body are rejected. Query parameters cannot change the
workspace or actor. The tools executed immediately are still role-filtered
Tier 0/1 reads. Chat also offers the Tier 2 mark-all and profile proposal tools;
an explicit validated notification or contact selection additionally offers
the matching proposal tool. All create approval cards stored by the server.
Chat never executes or approves them; only the separate approval
endpoint can apply an action.

The dedicated `agentLimiter` allows 10 requests per minute per authenticated
user across all workspaces, using the shared Redis store with prefix
`rl:agent:`. Existing general limits also apply. A blocked request returns
429 `RATE_LIMITED` with `Retry-After` before invoking Groq. The agent and both
general limiters keep local counters for fallback if Redis commands fail or
exceed their one-second deadline. Those fallback counts are per process, not
shared across instances. Missing clients also use memory stores. Membership
and dashboard cache reads have the same bounded wait and fall back to database
reads; authentication and membership checks still apply during an outage.
The shared workspace token budget below is separate from request throttling.

Validation failures return 400; malformed JSON also returns 400 without echoing
the body, and the application's 1 MiB body limit returns 413. Missing/invalid
authentication or an unavailable user profile returns 401. An unavailable
workspace or membership returns the existing non-enumerating 404. Provider
configuration/unavailability/rate limits return 503, timeouts return 504,
invalid or truncated completions return 502, and loop/size limits return 422.
Workspace token exhaustion returns 429 `AGENT_BUDGET_EXHAUSTED` with
`Retry-After`; a request exceeding the whole allowance returns 422
`AGENT_BUDGET_REQUEST_TOO_LARGE`. Invalid budget configuration returns 503.
Errors use the existing `{ error: { code, message, ... } }` API envelope.

Provider construction happens per accepted request, so missing Groq settings
disable chat with a 503 without preventing the rest of the API from starting.
HTTP unit tests run the real application middleware, read loop, and adapter
with mocked external services. Throttling tests exercise the memory fallback;
shared Redis enforcement and deployed Supabase/Groq behavior still need live
integration verification.

## Streaming chat

Use the same `POST /v1/workspaces/:workspaceId/agent/chat` endpoint and JSON
body, with `Accept: text/event-stream`. Omitted/wildcard Accept headers keep
the existing JSON response; normal Accept quality preferences are respected.
The request still passes through the same authentication, active membership,
per-user rate limiter and workspace token budget. There is no client `stream`
body field. Streaming uses the same selection/proposal rules as JSON chat.

The response uses UTF-8 Server-Sent Events with one JSON value per `data`
field. Example, omitting optional conversation continuity:

```text
event: text_delta
data: {"delta":"There are ","modelCall":2}

event: text_delta
data: {"delta":"2 members.","modelCall":2}

event: done
data: {"data":{"text":"There are 2 members.","modelCalls":2,"toolCalls":2}}

```

| Event | Meaning |
| --- | --- |
| `text_delta` | Append `delta` to the provisional answer for `modelCall`. |
| `text_reset` | Clear that call's provisional text: the validated completion requested tools, and another model call will follow. Contains `modelCall`. |
| `done` | The authoritative completed reply, using the existing `{ data: ... }` envelope, including `conversation_id` when requested and `proposal` when issued. Replace any draft with `data.text`. |
| `error` | The turn failed. Contains `{ error: { code, message } }` and, for budget exhaustion, `retry_after` in seconds. Discard provisional text. |

Text can arrive before the provider has finished or a turn has been saved.
Only `done` means success. EOF without `done` or an `error` event is an
interrupted turn. Do not automatically replay a POST: it can consume another
model budget reservation. This protocol has no event IDs or reconnection
replay. Use a streaming POST client such as `fetch`, not browser `EventSource`.

Before the first event, failures keep their regular JSON envelope and HTTP
status, including `Retry-After` on budget exhaustion. After streaming starts,
HTTP status stays 200 and failures use the terminal `error` event. No `done`
follows an error. Tool arguments/results, provider reasoning and token usage
are not streamed to the client. Tool calls are buffered and validated before
any handler runs; existing role filtering and untrusted-data envelopes apply.

Stateful turns send `done` only after history is committed. A failed partial
reply does not replace the previous transcript. Disconnecting cancels the
upstream request, prevents subsequent model/tool calls, and releases the
conversation lease. Reads already in flight may finish; a completed-history
commit already submitted to Redis may also finish after disconnect. As with
JSON calls, unreported provider usage retains the conservative reservation.

Responses disable compression/transformation and request proxy buffering be
disabled. Writes respect backpressure; a client stalled for ten seconds is
disconnected. Configure deployed proxy timeouts to allow tool/model turns;
there are no heartbeat or keepalive events during quiet tool reads.

Unit tests exercise real HTTP composition with mocked external services,
including live socket disconnects, stored-history failures, permission checks,
fragmented tool calls, Unicode split across bytes, malformed/truncated streams,
usage accounting, and slow clients. Deployed proxy behavior and live Groq
streaming remain integration verification work.

## Conversation continuity

Conversation history is opt-in and owned by the server:

```json
{ "message": "Show the rent summary.", "conversation_id": null }
```

A successful first reply includes `data.conversation_id`, a server-generated
UUID. Send that ID with a follow-up to resume the conversation:

```json
{ "message": "The London one.", "conversation_id": "<returned-uuid>" }
```

Send `null` again to start over, or omit the field for a stateless request.
Client-supplied messages/history, tool results, roles, and identity overrides
remain rejected. The response contains text, turn metrics, the ID and an
optional proposal; the saved transcript is never returned.
The conversation ID is not sent to the model.

Redis stores at most eight completed turns, with a 30-minute idle expiry
refreshed after a successful turn. The active conversation retains the existing
128 KiB message limit; old turns are removed as complete exchanges when room
is needed. This is short-term context, not durable chat history. Stored data
is bound to the authenticated user, membership, workspace, and role. An ID
cannot carry admin history into a member request or cross workspace/user
boundaries. Every request still traverses the existing auth/membership chain.

The loop rebuilds the system instruction and reads current context on every
turn. It uses old exchanges to interpret clarifications and instructs the
model to refresh workspace facts through tools. Historical tool messages keep
their untrusted-data envelopes; their call IDs are remapped to avoid collisions
with new calls. Strict stored-message validation rejects system/developer
messages, broken tool exchanges, oversized records, and unsupported tools.
Conversation history never authorizes a write or approves a proposal.

Follow-up chat refreshes proposal receipts from scoped server records and adds
`action_receipts` to the current bootstrap `get_my_context` result. Only
validated proposal call/result exchanges in retained history supply references;
user prose, unrelated tools and old receipt arrays cannot. Fresh membership
failures stop the turn. Missing or uncertain outcomes stay explicit rather
than inheriting old success claims. Receipts describe past actions, not current
notification, profile or contact state, and never restore selection or approval.
Clients can also read status with `GET /agent/proposals/:proposalId` under the
workspace prefix.
See [the receipt contract](PROPOSALS.md#read-status-and-continue-the-conversation).

Atomic Redis scripts acquire a turn lease and save a completed transcript only
while that lease still belongs to the request. Concurrent requests receive
409 `AGENT_CONVERSATION_BUSY` before a model call. The lease expires after ten
minutes; a late request cannot overwrite or release a newer request's lease.
A lost lease or transcript expiry during a turn returns 409
`AGENT_CONVERSATION_CONFLICT`. Failed turns retain the previous transcript;
failed first turns discard their unpublished record when cleanup is available.

Unknown, expired, or differently scoped IDs return the same 404
`AGENT_CONVERSATION_NOT_FOUND`. Redis failure or corrupt history returns 503
`AGENT_CONVERSATION_UNAVAILABLE`; history is never silently replaced with an
empty conversation. Redis commands have a one-second deadline. An already
submitted command may complete after that deadline; leases and records still
expire. A persistence failure can occur after provider usage has been charged.
Stateless requests remain available under the existing Redis-outage behavior.

Unit tests cover real Lua scripts with ioredis-mock, storage failures, scope
changes, lease races, history limits, clarification turns, and the real HTTP
composition with mocked transports. Actual Redis expiry/atomicity and live
model follow-up, prompt-injection, and numerical-fidelity evaluations remain
integration/evaluation work.

## Internal read loop

`runReadTurn({ data: { message }, context, provider })` in
`services/read-loop.service.js` runs one fresh read-only turn. Server code
supplies the authenticated context and the provider. Client data accepts only
a text message; conversation history, roles, tool results, and workspace IDs
are rejected. Each invocation starts with `get_my_context` and keeps its
messages and authenticated identity local to that invocation.

`runReadTurnWithHistory` is the internal stateful variant. It accepts validated
server-owned history separately from client `data` and returns `{ reply,
history }` to the conversation service for storage. Neither interface accepts
history in the client's message object. Current tool/model-call limits apply
per turn, excluding the exchanges restored from previous turns.
The optional server-only `loadActionReceipts({ history })` callback receives
validated retained history before the first model call. Its bounded output is
validated and placed inside the bootstrap tool envelope. `chat.service.js`
binds it to the immutable authenticated context and cancellation signal.

The injected provider implements:

```js
provider.chat({ messages, tools, trace })
// -> { text: string | null, toolCalls: [{ id, name, arguments: string }], usage? }
// usage: { promptTokens, completionTokens, totalTokens } | null
```

Messages use chat-completion roles and correlated `tool_call_id` values.
Tool definitions contain `name`, `description`, and the Zod `parameterSchema`;
the provider adapter owns converting schemas to its wire format. Only the
caller's permitted Tier 0/1 definitions are supplied by default. Production
chat also supplies the mark-all notification and profile proposal definitions. An
explicit notification selection adds the single-notification definition.
An explicit contact selection adds the contact deletion definition.
These are handled by a separate proposal callback that cannot execute the
write. Every read execution still passes through `executeReadTool` and the
handler's permission checks.

Tool messages wrap results in `{ kind: 'untrusted_tool_result', data }`, and
the fixed system instruction treats their contents as data and forbids
arithmetic. This preserves the instruction/data boundary; live-model prompt
injection and numerical-fidelity evaluations are still required.

The loop permits at most 6 model calls and 12 tool calls (including context),
8,000 input characters, 16,000 reply characters, 64 KiB per tool result, and
128 KiB of conversation messages. It rejects unavailable tools, reused call
IDs, malformed responses/arguments, and oversized results. Errors terminate
the turn; transport and unexpected service details are not returned to callers.
Success returns `{ text, modelCalls, toolCalls }`. Turn and tool traces share
a server-generated `turnId`; rejected batches identify their requested tools.
Provider calls receive a separate server-owned `trace` with the HTTP request
ID (when available), turn ID, workspace/caller IDs, and model-call index. The
Groq adapter uses this only for local logs; it is not sent to the model.

## Token accounting and budget scope

The adapter normalizes provider-reported prompt, completion, and total token
counts. Counts must be nonnegative safe integers, and the total must equal
prompt plus completion tokens. Unknown provider metadata is discarded.
Missing usage remains `null`, not a claim of zero consumption.

Usage is parsed before completion validation. A truncated or rejected
completion can therefore retain valid usage on its canonical error's internal
`usage` property. Normalization preserves only validated counts; that property
is separate from client-facing error details and is not serialized into HTTP
errors. Unreadable bodies, timeouts without usage, and invalid usage remain
unreported. Successful HTTP responses also keep their existing shape.

Each turn's success or failure trace contains a `usage` summary:
`knownPromptTokens`, `knownCompletionTokens`, `knownTotalTokens`,
`reportedModelCalls`, `unreportedModelCalls`, and `complete`. Totals include
reported usage from failed completions and calls followed by tool failures.
`complete` describes accounting coverage, not whether the turn succeeded.
When usage is incomplete, the known totals are only a partial count. The loop
rejects aggregate totals that cannot be represented safely instead of rounding.

The chat service applies **one shared allowance per workspace**, defaulting to
**100,000 input plus output tokens per UTC day**. Server configuration:

| Setting | Default | Range |
| --- | --- | --- |
| `AGENT_WORKSPACE_TOKEN_LIMIT` | `100000` | 1–1,000,000,000 tokens |
| `AGENT_BUDGET_PERIOD` | `day` | `day` or `month` (UTC calendar windows) |
| `AGENT_BUDGET_TIMEOUT_MS` | `3000` | 1–10,000 milliseconds |

Before every Groq call, the adapter reserves the UTF-8 byte size of the entire
serialized request plus its maximum completion tokens. This conservative
estimate includes messages and tool definitions; it is not an exact tokenizer
or dollar billing cap. Actual provider usage replaces the reservation after
successful or rejected completions. Missing usage keeps the reservation.
Redis outages allow calls without budget accounting. Traces retain reported
usage, but there is no automatic replay of missed accounting after recovery.
Budget denials occur before transport and do not count as model calls.

### Internal workspace budget service

`createWorkspaceBudget({ context, limit, period, timeoutMs? })` in
`services/budget.service.js` provides an internal reservation/reconciliation
primitive used by the chat service. `period` supports `day` or `month` with UTC
calendar resets; `limit` is a positive token count. Identity comes from
authenticated server context. Budget settings cannot come from chat input.

`reserve({ tokens })` atomically reserves against one Redis hash per workspace
and window and returns an immutable reservation. `settle({ reservation, usage })`
replaces that reservation with validated provider token usage exactly once.
Usage above the reservation is fully charged; unknown usage retains the
reservation. Later known usage can reconcile a held reservation. Pending and
settled records expire one hour after the window resets, allowing in-flight
calls to settle against their original window. The active window uses the
lowest configured allowance seen during rolling deployments; increases take
effect in the next window.

Redis outages **do not block the caller**: missing/not-ready clients, command
errors, and the bounded command timeout (default 3 seconds) return `null` from
`reserve`. Passing that null reservation to `settle` returns
`{ state: 'unavailable' }`; a settlement outage returns the same state. These
outcomes are logged without upstream error details. There is no local quota
balance, no automatic retry, and no claim that skipped calls were charged.
A command already sent to Redis may finish after the deadline, leaving a
conservative reservation. A settlement outage retains any stored reservation.

A confirmed exhausted allowance returns `AGENT_BUDGET_EXHAUSTED` (429) with an
internal reset timestamp, converted to `Retry-After` by the controller; a
reservation above the entire allowance returns
`AGENT_BUDGET_REQUEST_TOO_LARGE` (422). Invalid configuration or corrupt/missing
accounting state returns a typed 503 rather than resetting balances. Once the
provider has run, settlement failures are logged without discarding its reply
or masking its original error. Stored reservations remain charged.

`tests/unit/agent/budget.test.js` exercises the Lua scripts using ioredis-mock,
including workspace isolation, duplicate settlement, unknown usage, UTC
windows, and unavailable Redis. Real Redis atomicity, expiry, and network
failure behavior still need integration coverage. `chat-outage.test.js` runs
real request middleware with mocked stalled/reconnecting Redis transports,
checking successful chat and continued membership denial during outages.

Both JSON and SSE turns share this accounting path.

## Groq adapter

`providers/groq.provider.js` exports `createGroqProvider()`, which implements
the loop's provider interface using Node's built-in `fetch`:

```js
const { createGroqProvider } = require('./providers/groq.provider');
const { runReadTurn } = require('./services/read-loop.service');
const provider = createGroqProvider();
const reply = await runReadTurn({ data: { message }, context, provider });
```

This low-level example omits budgeting. Production HTTP chat uses
`runChatTurn`, which supplies the authenticated workspace budget to the adapter.

Set `GROQ_API_KEY` and `GROQ_MODEL` on the server; both are required. Choose a
standard model that supports function calling. Compound model IDs are rejected
because those systems can execute provider-hosted tools outside Kith. Only
function definitions already selected by the loop are sent to Groq, and
responses that contain provider-executed or undeclared tools are rejected.

The adapter converts Zod input schemas using `zod-to-json-schema`. This gives
the model structural constraints; the registry remains responsible for full
Zod validation, including refinements and transformations. Handler functions,
server context objects, and credentials are not serialized into tool definitions.

`GROQ_TIMEOUT_MS` defaults to 20000 (maximum 60000) and covers both the request
and response-body read. `GROQ_MAX_COMPLETION_TOKENS` defaults to 1024 (maximum
4096). Requests and JSON response bodies are capped at 256 KiB. SSE responses
are capped at 2 MiB including framing, with a 256 KiB per-event limit; existing
reply and tool-argument limits also apply to the assembled completion. The
endpoint is fixed to Groq's HTTPS chat-completions API, redirects are rejected,
and requests use one completion with no automatic retries. The server-only
second argument `chat(request, { onText, signal })` enables streaming through
an awaited text callback and supports cancellation. Neither control is sent
to the provider. Without `onText`, requests remain non-streaming.

Streaming requires a validated terminal completion and `[DONE]` before tool
execution or final success. The adapter supports Groq's `x_groq.usage` and
compatible top-level `usage` reports, while rejecting inconsistent reports,
provider-executed tools, upstream error chunks, and incomplete tool fragments.
The request deadline covers both transport and response consumption.

Successful responses normalize to `{ text, toolCalls, usage }`.
Truncated, malformed, or inconsistent completions terminate the turn. Timeout
and rate-limit codes survive the loop boundary, but upstream messages, bodies,
reasoning fields, and credentials are not exposed to callers or logs. Provider
token usage, model, HTTP status, latency, and server trace IDs are logged.

Unit tests use synthetic Groq responses, Web Streams, and the real read loop.
They do not make live model calls or verify a deployed model's behavior.
Reference: [Groq chat API](https://console.groq.com/docs/api-reference#chat-create)
and [tool use](https://console.groq.com/docs/tool-use).
Streaming wire types: [Groq SDK chat completions](https://github.com/groq/groq-typescript/blob/main/src/resources/chat/completions.ts).

## Database and verification

The source of truth is `migrations/001_schema.sql`: it adds `pg_trgm`, six GIN
indexes, and ranked-search RPCs for members, containers, tasks, ledger entries,
disputes and groups. Existing `pg_trgm` installations in either `public` or
`extensions` are supported. The RPCs receive the escaped pattern from the
shared `containsPattern` helper.

For an existing database, apply only these additions, with function creation
and permission changes in the same transaction; do not replay the consolidated
schema against existing tables. RPC execution is revoked from PUBLIC and
Supabase browser roles and granted to `service_role` when present. Schema edits
in the repository do not update a running database or its PostgREST schema cache.
Reload that cache after applying the additions and before exercising the tools.

Run `npm run test:unit -- --runInBand` from `backend`. Real trigram ranking,
workspace/ownership filtering, exact decimal matching, wildcard handling and
RPC permissions have integration coverage in
`tests/integration/database/ranked-search.test.js` and
`tests/integration/database/extended-ranked-search.test.js`. Run those suites
with the real Postgres/PostgREST/Redis test stack and the updated schema.
Unit tests mock RPC results and do not prove that the SQL or indexes work.

Profile proposal tests cover exact changed fields, current membership,
conditional updates, audit events, receipts and retry idempotency. They also
check that activity timestamps and unrelated profile edits do not invalidate
a card, while changes to reviewed fields do.
Contact deletion tests cover ownership, full reviewed-state comparisons,
conditional conflicts and receipts that never restore selection. Live
database/PostgREST, model and deployed-proxy verification remain pending. The existing `ioredis-mock`
listener warning is still present in full unit runs.
