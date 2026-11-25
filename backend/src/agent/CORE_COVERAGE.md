# Core backend agent coverage checklist

Baseline established on **2026-11-18**, including the existing uncommitted
resolve-dispute implementation. This tracks actual reachable scope, not the
presence of an underlying service. Each subsequent approved slice updates it.
Frontend work, uploads, Tier 5 and lower-priority expansion remain excluded.

## Verification status

- Hardened resolution + ordinary dispute service targeted units:
  **5 suites / 470 tests passed** with the CLI timeout override.
- Initial full unit baseline: **130 suites passed / 1 failed; 5,600 tests passed /
  3 failed**, all failures were 5-second timeouts in `dispute-raise-route.test.js`.
- Post-hardening full unit regression: **132 suites / 5,617 tests passed**
  (including the new viewed-container suite), with no timeout override.
- Dispute integration suites (`dispute-proposals`, `dispute-resolution-atomic`,
  `dispute-raise-atomic`, `dispute.routes`): **4 suites / 66 tests passed** on a local Postgres 16 +
  PostgREST v12.0.2 + Redis stack with `migrations/001_schema.sql` applied. This
  is not a CI run. The remaining integration/rate-limit suites were not run.
- Real-model behavior, target database ranked-search definitions/indexes/ACLs
  and deployment correctness: **unverified**. No production data or paid calls.
- The [approved resolution SQL patch](DISPUTE_EXECUTION_SCHEMA_PROPOSAL.md)
  is implemented in `migrations/001_schema.sql` and the reviewed service branch.
  It has **not been deployed** to an existing database. The real
  `dispute-resolution-atomic.test.js` race/rollback/ACL suite passed locally;
  its ACL fixtures use test-created roles, not target Supabase roles.

Verification commands from `backend/` (Jest 29 uses the singular flag):

```sh
npm run test:unit -- --runInBand --testPathPattern=dispute-resolve
npm run test:unit -- --runInBand --testTimeout=30000
# Only on the isolated real test stack; not run in this sandbox:
npm run test:integration -- --testPathPattern=dispute-proposals
```

ESLint is installed but no project configuration was found; normal lint cannot
run as configured. The added suite **passed** explicit `no-undef` /
`no-unused-vars` checks with Node/Jest/ES2022 environments, plus `node --check`
and `git diff --check`. These checks do not execute the integration cases.

## Reachable core writes (preserve these scopes)

| Tool | Tier | Current supported scope | Remaining core extension |
| --- | --- | --- | --- |
| `update_my_profile` | 2 | Caller account profile | No auth expansion |
| `update_task` | 2 | Own active unconfirmed task progress/completion note | Admin transitions stay separate |
| `create_ledger_entry` | 2 | Own base-currency non-crypto event contribution, pending even for admin | Recurring self; separate Tier 4 on-behalf/proxy; expense permission/tier checkpoint |
| `confirm_ledger_entry` | 3 | Pending proof-free base-currency event contribution, active non-proxy participant | Existing attachments/statuses, recurring and approved entry forms |
| `create_container` | 3 | Event metadata/date/tracking flags | Recurring schedule and permitted base-currency budget settings |
| `create_member` | 3 | Unlinked ordinary member or proxy managed by requesting admin; fixed member role | Supported non-auth metadata only |
| `add_participants` | 3 | One active non-proxy member in an active event | Bounded exact sets, recurring, approved proxy/target cases |
| `create_task` | 3 | Assigned/unassigned task in active task-enabled event/recurring container | Separate reassignment/batch tools; proxy eligibility decision |
| `admin_confirm_task` | 3 | Completed unconfirmed task, exact existing attachment metadata | Transactional hardening, never upload finalization |
| `raise_dispute` | 4 | Own confirmed positive base-currency event contribution | Reviewed transaction; recurring and approved on-behalf/proxy cases |
| `resolve_dispute` | 4 | Admin closes selected owner-raised dispute; transaction locks eligibility and requires exact dual transitions | Broaden approved cases only later; real-stack/deployment verification |

All existing tools retain independent permission checks, structured current-
request selection and separate approval. Both dispute actions require the
private token-bound typed confirmation endpoint. Names, historical IDs and
spoken/chat “confirm” do not grant selection or approval.

## Missing core tools (not exposed as completed)

- [ ] Tier 2: `add_dispute_note`.
- [ ] Tier 3 containers: `update_container`, `archive_container`.
- [ ] Tier 3 membership: `update_member`, `update_participant`.
- [ ] Tier 3 tasks: `bulk_create_tasks`, `reassign_task`.
- [ ] Tier 3 groups: `create_group`, `update_group`, `add_group_members`.
- [ ] Tier 3 invitations: `create_invite`.
- [ ] Tier 4 ledger: `add_correction`, on-behalf/proxy `create_ledger_entry`,
  `delete_ledger_entry`, `delete_proof`.
- [ ] Tier 4 targets: `set_target`, `override_cycle`.
- [ ] Tier 4 tasks: `override_task_status`, `delete_task`.
- [ ] Tier 4 lifecycle: `delete_container`, `complete_container`, `delete_member`,
  `remove_participant`, `revoke_invite`, `delete_group`, `delete_milestone`.

## Remaining platform slices

- [x] Reviewed resolution transactional checks and required dual transitions
  implemented; ordinary resolver lock order coordinated. Local real-stack
  integration passed; CI and target deployment remain pending.
- [ ] Other money/target/destructive transactional checks beyond disputes.
  Include ordinary HTTP/job writers in lock/race tests.
- [x] Reviewed dispute **raise** transactional hardening implemented in the
  schema and service ([patch](DISPUTE_RAISE_SCHEMA_PROPOSAL.md)); local real-stack
  integration passed. CI and target deployment remain pending.
- [x] Separate read-only `viewed_container_id` context; never action selection.
- [ ] Service-calculated monthly summaries after date/timezone/status semantics
  are settled; no model arithmetic.
- [ ] Groq STT/TTS after availability, audio limits, privacy and modality contract
  review. No provider migration or new dependency without discussion.
- [ ] Deterministic loop/proposal fixtures, real-service CI coverage, redacted
  traces and opt-in paid Groq evaluations after spend authorization.
- [ ] Minimal configuration-level provider factory, Groq only.

**Explicit later gates:** foreign-currency/crypto writes, expense authorization
and tier, proxy manager vs any-admin scope, broadened disputable statuses,
transactional/schema patches and durable execution markers. Corrections remain
additional positive confirmed linked entries, not replacements or reversals.

**Intentionally excluded:** agent upload-finalizers `confirm_proof` /
`confirm_task_proof`, all Tier 5, frontend implementation. Existing lower-priority
handlers stay intact; no new housekeeping/contact/timeline/milestone creation
or update work is part of this milestone.
