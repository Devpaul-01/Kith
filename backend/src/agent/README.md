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
429 `RATE_LIMITED` with `Retry-After` before invoking Groq. As with the existing
limiters, a missing Redis client or synchronous store-construction failure
falls back to an in-memory store with a warning; those counters are local to
each process. Request limits and per-completion token caps do not enforce a
per-user or workspace spending budget.

Validation failures return 400; malformed JSON also returns 400 without echoing
the body, and the application's 1 MiB body limit returns 413. Missing/invalid
authentication or an unavailable user profile returns 401. An unavailable
workspace or membership returns the existing non-enumerating 404. Provider
configuration/unavailability/rate limits return 503, timeouts return 504,
invalid or truncated completions return 502, and loop/size limits return 422.
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

These are per-turn structured logs and internal provider metadata, not a
durable quota ledger. The agreed budget scope is **one shared allowance per
workspace**. The allowance amount, reset schedule, reservation/reconciliation
policy, and durable enforcement remain for the budget milestone.

Workspace token budgets, streaming, and server-owned conversation memory are
subsequent increments.

## Groq adapter

`providers/groq.provider.js` exports `createGroqProvider()`, which implements
the loop's provider interface using Node's built-in `fetch`:

```js
const { createGroqProvider } = require('./providers/groq.provider');
const { runReadTurn } = require('./services/read-loop.service');
const provider = createGroqProvider();
const reply = await runReadTurn({ data: { message }, context, provider });
```

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
token usage, model, HTTP status, latency, and server trace IDs are logged; this
does not yet enforce a per-user or per-workspace spending budget.

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
