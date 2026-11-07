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
