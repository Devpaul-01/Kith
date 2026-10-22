# Documentation Reconciliation — Baseline

Recorded at the start of this audit pass. See `DISCREPANCY_REGISTER.md` for
findings and `../../../patches/documentation-reconciliation/MANIFEST.md`
for how the resulting changes were delivered.

## Repository

- URL: https://github.com/Devpaul-01/Kith
- Branch audited: `main`
- Baseline commit: `04fd6a9d068404ddb1a53272ef993aa43cf7e193` ("update schema file")
- Working tree at clone time: clean, no uncommitted changes, up to date with `origin/main`.
- Other branches on the remote (not audited in this pass, listed for reference):
  `BugFix`, `backend-coverage-gaps`, `batch/auth-audit-fixes`, `bug/fixes`,
  `ci-integration`, `ci/frontend-tests`, `demo`, `develop`, `docs`,
  `feat/atomic-contact-rpc`, `feat/dashboard-enhancements`,
  `fix/ci-integration-tests`, `fix/container-schema-and-imports`,
  `fix/frontend-backend-gap-fixes`, `fix/idempotency-race-and-resume-experiments`,
  `fix/landing-page-content`, `flaky-ci-fix`, `frontend-test`, `master`,
  `refactor/backend-optimizations`, `refactor/backend-refinement`,
  `refactor/service-layer-extraction`, `refactor/workspace-cleanup`,
  `scriptupdate`, `test/backend-coverage-gaps`, `test/integration-suite-doc3`,
  `test/unit-test-suite`.

## Project structure (top level)

```
backend/   — Express API, workers, scheduler, Jest test suites
frontend/  — React/TypeScript app (Vitest)
migrations/ — 4 SQL files: 001_schema.sql, 002_ledger_integrity_and_carry_forward_debt.sql,
              003_fix_contributor_target_race.sql, 004_fix_ledger_entry_duplicate_check_race.sql
docs/      — documentation (this audit's output lives under docs/audits/)
media/     — screenshots/assets referenced by README
.github/workflows/test.yml — single CI workflow ("Test Suite")
```

## Stack, as verified from source (not assumed from prior docs)

- Backend: Node.js 22 (CI) / `engines.node >= 18.0.0` (package.json), Express 4,
  `@supabase/supabase-js` 2.45.4 talking to Postgres via PostgREST, Redis via
  `ioredis` + `rate-limit-redis` + BullMQ, Firebase Admin for auth, Resend for
  email, Sentry, Winston logging, Zod validation.
- Frontend: present under `frontend/`, Vitest-based test suite (not deeply
  audited in this pass — see "Not covered" below).
- Test runner: Jest, configured as three named **projects** in
  `backend/package.json`'s `"jest"` block: `unit`, `integration`, `rate-limit`.
- CI: single GitHub Actions workflow, `.github/workflows/test.yml`, with jobs
  `unit-tests` and `frontend-tests` active, and (before this audit's changes)
  an `integration-tests` job present only as a commented-out block.

## Test baseline (what actually ran, before changes)

Environment constraints: this audit environment has outbound network access
only to package registries (npm) and GitHub, and has **no Docker daemon
available**. Anything requiring Postgres/PostgREST/Redis containers could
not be executed directly here and was instead validated by (a) reading the
CI workflow/service definitions and (b) local test *discovery* checks
(`jest --listTests`), not full execution.

| Command | Result | Notes |
|---|---|---|
| `npm ci` (backend) | Succeeded — 735 packages installed | Several deprecation warnings from transitive deps (supertest, rimraf, glob, cron-parser, superagent, uuid, eslint); none block install. |
| `npm run test:unit` | **49 suites / 847 tests passed, 0 failed** | No external services required; ran in ~7s. |
| `npx jest --selectProjects rate-limit --listTests` | Discovers exactly `tests/integration/redis/rate-limiting.test.js` | Confirms Jest project config matches the intent described in that file's own header comment; this is test *discovery*, not execution. |
| `npm run test:ratelimit` (full execution) | **Not run in this environment** | Requires Postgres + PostgREST + Redis, unavailable here (no Docker). Execution path was instead validated by running the equivalent steps as a GitHub Actions job (see CI workflow changes) and reasoning from the service/test code. |
| `npm run test:integration` (full execution) | **Not run in this environment** | Same constraint. Also out of scope to fully de-flake per the task's Requirement 2 (document status, don't solve the whole problem as a prerequisite). |
| Frontend tests (`npm test` under `frontend/`) | **Not run in this pass** | Out of scope for this pass; see "Not covered" below. |

No failures found in this pass are attributable to this audit's own changes,
since the only suite actually executed (`unit`) was run both as a baseline
read and is unaffected by the documentation/CI changes made.

## Root cause established for Requirement 1 (rate-limit tests not running in CI)

Confirmed by reading `.github/workflows/test.yml` at the baseline commit: the
**entire** `integration-tests` job — which was the only place
`npm run test:ratelimit` was invoked — was commented out in its entirety,
with an inline note: *"Disabled on 2026-08-25 — PostgREST schema cache
issues and flaky test environment setup."* The rate-limit suite was never a
separate job; it was the last step of the disabled integration job, so
disabling integration silently took rate-limit testing down with it. The
rate-limit tests themselves were not failing or incompatible with CI — they
were simply never invoked by any active job.

Separately, a second, independent defect was found and fixed as part of
restoring this: `backend/package.json`'s `test:docker:seed` script referenced
`migrations/001_schema.sql` relative to the `backend/` working directory,
but the `migrations/` directory lives at the repository root
(`backend/migrations/` does not exist), and only migration 001 of the four
present migrations was referenced at all. See `DISCREPANCY_REGISTER.md`
items `DR-001` and `DR-002`.

## Not covered in this pass (explicitly deferred, not claimed as done)

This task's full instructions describe a ten-phase, whole-repository audit
(API docs, DB schema/RPC docs, auth/security docs, Redis/queue/worker docs,
environment-variable inventory, frontend docs, etc.). Given the scope of a
single working session, this pass prioritized and fully completed:

1. Requirement 1 — rate-limit tests now execute in CI (dedicated job).
2. Requirement 2 — README now carries an accurate, honest integration-test
   flakiness notice.
3. A grounded (not exhaustive) discrepancy register focused on the Testing &
   CI documentation, since that is what Requirements 1 and 2 touch directly.
4. Requirement 3 — delivery via patch files (and a branch, if push access is
   available — see the final report).

**Not yet audited**: extending `test:docker:seed` itself to apply migrations
002-004 (it currently seeds migration 001 only, matching its pre-existing
scope — only its path was broken); the database schema/migration docs
beyond that, the full API/route documentation,
Redis/caching guarantee language elsewhere in the README (e.g. "atomic",
"exactly once" claims under "Measured, Not Assumed" — these were read and
appear to be backed by the linked experiment scripts, but were not
independently re-verified line-by-line here), the frontend test suite and
its documentation, environment-variable documentation, and the remaining 26
branches on the remote. These are legitimate candidates for a follow-up
pass and are listed here rather than silently skipped.
