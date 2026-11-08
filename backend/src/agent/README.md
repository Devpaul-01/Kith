# Agent tools

This module currently provides read tools through `getAvailableTools(context)`
and `executeReadTool({ name, args, context })`. Server code must build context
after the existing auth and membership middleware:

```js
const context = { userId: req.user.id, member: req.member, workspace: req.workspace, requestId: req.requestId };
```

`find_member` and `find_container` take `{ query, limit? }`. Queries are trimmed
and must contain 2–200 characters; limits default to 10 and range from 2 to 20.
Workspace and actor IDs are always supplied by server context.

Results contain `query`, `status`, `candidates`, and `has_more`. Candidates are
ranked in PostgreSQL: exact names, literal substrings, then trigram matches,
with score/name/ID tie-breakers. `score` is a similarity value, not a probability.
Members must be active and not deleted; containers may be archived/completed
but must not be deleted. Both searches exclude deleted workspaces.

- `not_found`: no candidates.
- `single_match`: one candidate to confirm with the user before a write.
- `ambiguous`: multiple candidates; the user must choose or refine the query.

No result contains an automatically resolved ID. A future proposal executor
must enforce the user's entity selection separately from action approval.
`has_more` means further candidates were omitted; refine the query or increase
the limit. User-supplied names remain untrusted data.

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

## Chat endpoint

`POST /v1/workspaces/:workspaceId/agent/chat` accepts a bearer token and a JSON
body containing only a nonempty `message` (up to 8,000 characters):

```json
{ "message": "Show my workspace dashboard." }
```

This first HTTP increment returns one complete JSON response using the existing
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
`Cache-Control: no-store`. Each request starts a fresh conversation. Streaming
and server-owned conversation memory remain later increments of the architecture.

The route inherits `requireAuth` → `loadDbUser` → `requireMembership` from the
workspace router. Context comes exclusively from those middleware results.
Client-supplied history, roles, tools, identity fields, model settings, and
workspace IDs in the body are rejected. Query parameters cannot change the
workspace or actor. The tools offered and executed are still role-filtered
Tier 0/1 reads; chat does not execute writes or approve proposals.

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

## Internal read loop

`runReadTurn({ data: { message }, context, provider })` in
`services/read-loop.service.js` runs one fresh read-only turn. Server code
supplies the authenticated context and the provider. Client data accepts only
a text message; conversation history, roles, tool results, and workspace IDs
are rejected. Each invocation starts with `get_my_context` and keeps its
messages and authenticated identity local to that invocation.

The injected provider implements:

```js
provider.chat({ messages, tools, trace })
// -> { text: string | null, toolCalls: [{ id, name, arguments: string }], usage? }
// usage: { promptTokens, completionTokens, totalTokens } | null
```

Messages use chat-completion roles and correlated `tool_call_id` values.
Tool definitions contain `name`, `description`, and the Zod `parameterSchema`;
the provider adapter owns converting schemas to its wire format. Only the
caller's permitted Tier 0/1 definitions are supplied. Every execution still
passes through `executeReadTool` and the handler's permission checks.

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

Streaming and server-owned conversation memory remain subsequent increments.

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
4096). Requests and streamed response bodies are capped at 256 KiB. The
endpoint is fixed to Groq's HTTPS chat-completions API, redirects are rejected,
and requests are non-streaming with one completion and no automatic retries.

Successful responses normalize to `{ text, toolCalls, usage }`.
Truncated, malformed, or inconsistent completions terminate the turn. Timeout
and rate-limit codes survive the loop boundary, but upstream messages, bodies,
reasoning fields, and credentials are not exposed to callers or logs. Provider
token usage, model, HTTP status, latency, and server trace IDs are logged.

Unit tests use synthetic Groq responses, Web Streams, and the real read loop.
They do not make live model calls or verify a deployed model's behavior.
Reference: [Groq chat API](https://console.groq.com/docs/api-reference#chat-create)
and [tool use](https://console.groq.com/docs/tool-use).

## Database and verification

The source of truth is `migrations/001_schema.sql`: it adds `pg_trgm`, two GIN
indexes, and `search_members_ranked` / `search_containers_ranked`. Existing
`pg_trgm` installations in either `public` or `extensions` are supported.
The RPCs receive the escaped pattern from the shared `containsPattern` helper.

For an existing database, apply only these additions, with function creation
and permission changes in the same transaction; do not replay the consolidated
schema against existing tables. RPC execution is revoked from PUBLIC and
Supabase browser roles and granted to `service_role` when present. Schema edits
in the repository do not update a running database or its PostgREST schema cache.
Reload that cache after applying the additions and before exercising the tools.

Run `npm run test:unit -- --runInBand` from `backend`. Real trigram ranking,
workspace filtering, wildcard handling, and RPC permissions are covered by
`tests/integration/database/ranked-search.test.js`. Run that suite with
the real Postgres/PostgREST/Redis test stack and the updated schema. Unit tests
mock RPC results and do not prove that the SQL or indexes work.
