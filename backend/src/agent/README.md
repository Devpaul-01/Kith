# Agent tools

This module currently provides read tools through `getAvailableTools(context)`
and `executeReadTool({ name, args, context })`. Server code must build context
after the existing auth and membership middleware:

```js
const context = { userId: req.user.id, member: req.member, workspace: req.workspace };
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

## Internal read loop

`runReadTurn({ data: { message }, context, provider })` in
`services/read-loop.service.js` runs one fresh read-only turn. Server code
supplies the authenticated context and the provider. Client data accepts only
a text message; conversation history, roles, tool results, and workspace IDs
are rejected. Each invocation starts with `get_my_context` and keeps its
messages and authenticated identity local to that invocation.

The injected provider implements:

```js
provider.chat({ messages, tools })
// -> { text: string | null, toolCalls: [{ id, name, arguments: string }] }
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

The authenticated HTTP endpoint, rate limiting, workspace token budgets, and
server-owned conversation memory are subsequent increments.

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

Successful responses normalize to the existing `{ text, toolCalls }` contract.
Truncated, malformed, or inconsistent completions terminate the turn. Timeout
and rate-limit codes survive the loop boundary, but upstream messages, bodies,
reasoning fields, and credentials are not exposed to callers or logs. Provider
token usage, model, HTTP status, and latency are logged when available; this
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
