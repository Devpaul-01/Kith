# Core backend agent coverage checklist

Baseline established on **2026-11-18**, including the existing uncommitted
resolve-dispute implementation. This tracks actual reachable scope, not the
presence of an underlying service. Each subsequent approved slice updates it.
Frontend work, uploads, Tier 5 and lower-priority expansion remain excluded.

## Verification status

- Dispute-resolution targeted unit suite: **4 suites / 436 tests passed**.
- Initial full unit baseline: **130 suites passed / 1 failed; 5,600 tests passed /
  3 failed**, all failures were 5-second timeouts in `dispute-raise-route.test.js`.
- Full unit regression with a CLI-only 30-second timeout override:
  **131 suites / 5,603 tests passed**. No test/runtime timeout settings were
  changed in source.
- `tests/integration/database/dispute-proposals.test.js`: **12 cases added,
  not executed**. Requires the isolated Postgres/PostgREST/Redis test stack,
  unavailable in this sandbox. Jest discovery and syntax checks are separate
  from real integration verification.
- Real-model behavior, target database ranked-search definitions/indexes/ACLs
  and deployment correctness: **unverified**. No production data or paid calls.
- The [reviewed resolution SQL proposal](DISPUTE_EXECUTION_SCHEMA_PROPOSAL.md)
  is **review only**. `migrations/001_schema.sql` was not changed or applied.

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
| `resolve_dispute` | 4 | Admin closes selected owner-raised dispute on eligible disputed base-currency event contribution with confirmation metadata | Reviewed transaction; broaden approved cases only later |

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

- [ ] Transactional checks for reviewed resolution, then reviewed raise and
  other reviewed money/target/destructive operations as independently reviewed
  patches. Include ordinary HTTP/job writers in lock/race tests.
- [ ] Separate read-only `viewed_container_id` context; never action selection.
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
