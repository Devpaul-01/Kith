# Documentation Reconciliation — Discrepancy Register

Scope note: this register covers the Testing & CI surface area touched by
this audit pass (see `BASELINE.md` for what was and wasn't covered). It is
not a claim of full-repository reconciliation.

---

### DR-001 — README overstated CI coverage for integration/rate-limit suites

- **Severity:** High
- **Category:** 1 (Incorrect documentation), 9 (Test/CI documentation discrepancy)
- **Affected doc:** `README.md`, "Testing & CI" section
- **Relevant source:** `.github/workflows/test.yml` (baseline commit `04fd6a9`)
- **Documentation said:** "Tests are split into three Jest projects and run
  automatically on every push and pull request to `main`/`develop` via
  GitHub Actions," with no distinction between the three suites.
- **Implementation did:** Only the `unit-tests` and `frontend-tests` jobs
  were active. The entire `integration-tests` job — the only job that ran
  either `test:integration` or `test:ratelimit` — was commented out.
- **Why it matters:** A reader relying on this section would believe a
  green CI check meant integration and rate-limit coverage ran, when
  neither did. This is exactly the kind of incorrect operational claim the
  audit was asked to catch.
- **Correction:** README now has a per-suite "Runs in CI?" column and an
  explicit "Development status" subsection. See `README.md` diff.
- **Runtime code change required:** No (documentation only).
- **Validation:** Read `.github/workflows/test.yml` directly; confirmed job
  names and the commented-out block boundaries.
- **Status:** Fixed in this pass.

---

### DR-002 — `test:docker:seed` pointed at a nonexistent path; still only seeds migration 001 of 4

- **Severity:** High
- **Category:** 6 (Incorrect examples or commands)
- **Affected doc/config:** `backend/package.json` (`scripts.test:docker:seed`),
  referenced from `README.md`'s "Testing & CI" section
- **Relevant source:** `migrations/001_schema.sql` (repo root);
  `backend/package.json`
- **Documentation/config said:** `PGPASSWORD=test psql ... -f migrations/001_schema.sql`,
  run via `npm run test:docker:seed` from the `backend/` directory (npm's
  working directory for a script defined in `backend/package.json`).
- **Implementation did:** `migrations/` exists only at the repository root;
  `backend/migrations/` does not exist. The path as written would fail with
  "No such file" when actually run.
- **Why it matters:** Anyone following the README's local setup instructions
  verbatim would hit a broken command before the test database was seeded
  at all — directly relevant to the rate-limit and integration tests this
  audit was asked to get running, since those tests rely on this schema
  being present.
- **Correction:** `test:docker:seed` now points at the correct path
  (`../migrations/001_schema.sql`, correct for execution from `backend/`),
  with `-v ON_ERROR_STOP=1` added so a failed seed halts instead of
  silently continuing. It intentionally still applies only migration 001,
  matching its original scope — the CI `rate-limit-tests` job is the one
  that applies all four migrations, directly via its own `psql` steps (see
  `.github/workflows/test.yml`), since CI does not go through this npm
  script. Extending `test:docker:seed` itself to cover migrations 002-004
  was considered but left out of this pass; see `BASELINE.md` "Not covered."
- **Runtime code change required:** No (test/CI tooling only; no production
  code path touched).
- **Validation:** Confirmed `backend/migrations/` does not exist and
  `migrations/001_schema.sql` exists at repo root (`find`). Confirmed the
  corrected script parses as valid JSON.
  **Not validated:** actually running the seed against a live Postgres
  instance, since no Docker daemon was available in this environment — see
  `BASELINE.md`.
- **Status:** Fixed in this pass (path only); scope intentionally unchanged
  from migration 001 — not a false completion claim.

---

### DR-003 — Rate-limit tests existed and were correctly configured as a Jest project, but were never invoked by any active CI job

- **Severity:** Critical
- **Category:** 9 (Test/CI documentation discrepancy) — also a direct gap
  against Requirement 1 of this task
- **Affected doc/config:** `.github/workflows/test.yml`
- **Relevant source:** `backend/package.json` (`jest.projects`, the
  `rate-limit` project), `backend/tests/setup.ratelimit.js`,
  `backend/tests/integration/redis/rate-limiting.test.js`
- **Documentation/config said:** `README.md` implied these tests ran in CI
  (see DR-001). `package.json` correctly defines `npm run test:ratelimit`
  as `jest --selectProjects rate-limit`, and the Jest project config
  correctly isolates it to the one file.
- **Implementation did:** The test file and its dedicated setup file
  (`setup.ratelimit.js`) are correctly written — they're deliberately
  isolated into their own Jest project specifically so `NODE_ENV` can be
  forced to `'production'` before `app.js` is first required (see that
  file's own header comment, which is accurate and was left as-is). But
  the only CI job that ever ran `npm run test:ratelimit` was the last step
  of the disabled `integration-tests` job, so this correctly-built suite
  was never exercised in CI at all — not because of a test bug, but because
  of a workflow-level omission.
- **Why it matters:** This is Requirement 1's root cause.
- **Correction:** Added a dedicated `rate-limit-tests` job to
  `.github/workflows/test.yml`, independent of the still-disabled
  `integration-tests` job, with its own Postgres + PostgREST + Redis
  services, migration application (see DR-002), and a `npm run
  test:ratelimit` step with `TEST_SUPABASE_URL` / `TEST_REDIS_URL` set to
  match those services.
- **Runtime code change required:** No.
- **Validation:** `.github/workflows/test.yml` parses as valid YAML after
  the change (`yaml.safe_load`); `jobs` now include `rate-limit-tests`
  alongside `unit-tests` and `frontend-tests`. `npx jest --selectProjects
  rate-limit --listTests` locally confirms exactly one file is discovered
  by the project the new CI step invokes. **Not validated:** an actual
  GitHub Actions run (no push access confirmed in this environment — see
  final report) or actual execution of the rate-limit assertions against
  live services (no Docker here).
- **Status:** Fixed in this pass, pending a real CI run to confirm
  green/red status; the workflow change itself is structurally verified.

---

### DR-004 — Integration-test CI disablement reason was documented only as a code comment, not in user-facing docs

- **Severity:** Medium
- **Category:** 3 (Missing documentation), 8 (Missing operational/
  troubleshooting guidance)
- **Affected doc:** `README.md`
- **Relevant source:** `.github/workflows/test.yml` comment block
- **Documentation said:** Nothing — the only record of integration tests
  being disabled in CI was an inline YAML comment, which a README reader
  would never see.
- **Implementation did:** Integration tests have been disabled in CI since
  2026-08-25 per that comment, with a stated (not independently
  re-verified in this pass) cause of PostgREST schema-cache visibility and
  service start-up ordering.
- **Why it matters:** This is Requirement 2 of the task — the person using
  this repo needs to see this status without reading workflow YAML.
- **Correction:** Added the "Development status: integration-test
  flakiness in CI" subsection to `README.md`, stating the issue is
  acknowledged and being worked on, without inventing a resolution date or
  overstating the established cause, and without claiming the whole
  application is broken.
- **Runtime code change required:** No.
- **Validation:** Manual review of the added section against the task's
  explicit constraints (no fabricated root cause beyond what the workflow
  comment already stated, no resolution date, no "fully resolved" language).
- **Status:** Fixed in this pass.

---

## Deferred / not addressed in this pass

| ID | Area | Why deferred |
|---|---|---|
| DR-D1 | Full API/route documentation vs. actual Express routes | Out of scope for this pass given time; requires systematically diffing every route file against docs. Flagged for a follow-up audit pass. |
| DR-D2 | Database schema/RPC documentation beyond migration ordering | Same — only the rate-limit-relevant migration-application bug (DR-002) was investigated; the rest of the schema/RPC docs were not line-by-line verified. |
| DR-D3 | "Atomic" / "exactly once" language under "Measured, Not Assumed" | Read, and appears backed by the linked experiment scripts/results (`backend/scripts/results/`), but not independently re-run or re-verified against the current schema in this pass. |
| DR-D4 | Frontend test suite and its documentation | Not inspected in this pass. |
| DR-D5 | Environment-variable inventory across `.env.example`/docs/code | Not inspected in this pass. |
| DR-D6 | The 26 non-`main` branches on the remote | Not inspected; `main` was treated as the baseline per the task's instruction to work from the current implementation. |

A full reconciliation of DR-D1 through DR-D6 would require a dedicated
follow-up pass; this register should be treated as a living document and
extended rather than restarted.
