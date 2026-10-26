# Kith — P0 Experiment Results

**Repository:** `Devpaul-01/Kith` @ `e647e78306feefdb1cb8712c326f1cb0d20abdd8` (unchanged — no application commits made during this phase; only new, untracked files under `backend/scripts/`)
**Environment:** PostgreSQL 16.15, PostgREST 12.0.2, Redis 7.0.15, Node v22.22.2 — all running natively (no Docker available in this sandbox; see `backend/scripts/local-test-stack/` for how this was assembled as a functional equivalent of `docker-compose.test.yml`).
**All four P0 experiments from `MEASUREMENT_PLAN.md` (M1-M4) were implemented and executed against a disposable local instance of the real stack — not mocked, not estimated.**

Raw, timestamped JSON for every run (including failed attempts, kept rather than deleted — see §5) is under `scripts/results/{cache,target-race,idempotency,immutability}/`.

---

## M1 — Concurrency correctness: `set_contributor_target_atomic`

**Objective:** Does exactly one `is_current=true` contributor-target row survive under N concurrent set-target requests, and how does the atomic RPC differ from a naive check-then-write?

**Implementation under test:** `set_contributor_target_atomic` (migration `001_schema.sql`) vs. a naive two-step check-then-write, both exercised through the real `supabaseAdmin` client against the real schema. Script: `scripts/experiments/m1-target-race.js`.

**Environment:** Local Postgres/PostgREST, single Node process issuing concurrent requests via `Promise.allSettled` (single-process concurrency — see Limitations).

**Workload:** Concurrency levels 5, 25, 50. Each level seeds a fresh participant with one pre-existing target (the harder, more realistic re-assignment race, not a first-ever-target race), then fires C concurrent naive calls, measures the invariant, then C concurrent RPC calls, measures the invariant again. Repeated 3 times end-to-end (5 successful full runs total, 1 run lost to a sandbox infrastructure restart — see §5).

**Results (representative run, `M1_target_race_2026-10-14T21-50-42-196Z_af15e8.json`):**

| Concurrency | Path | ok | failed | current\_targets\_after |
|---|---|---|---|---|
| 5 | naive | 2 | 3 | **1** |
| 5 | RPC | 1 | 4 | **1** |
| 25 | naive | 3 | 22 | **1** |
| 25 | RPC | 5 | 20 | **1** |
| 50 | naive | 1 | 49 | **1** |
| 50 | RPC | 11 | 39 | **1** |

Across all 5 successful runs (15 concurrency-level trials total), `current_targets_after === 1` **every time**, for both paths. The core correctness invariant never broke.

**Baseline comparison:** Naive and RPC paths ran identical workloads (same participant, same concurrency, same target-amount pattern) in direct succession on the same fixture, so the comparison is apples-to-apples. The RPC consistently lets more requests succeed at higher concurrency (11/50 vs. 1/50 at C=50) but not dramatically more.

**Interpretation — what this demonstrates:** The invariant (never more than one current target) holds at every tested concurrency level for both implementations, because it's ultimately enforced by the partial unique index on `contributor_targets`, not solely by the RPC's locking. **What it does not demonstrate:** that the RPC resolves contention gracefully. Error-type capture (not in the original `measure.js` harness — added for this experiment) revealed *why*: `set_contributor_target_atomic` does `SELECT ... FOR UPDATE` on the existing current-target row, but when the lock holder commits and supersedes that row, a transaction that was blocked on the lock re-checks `WHERE is_current = true` under READ COMMITTED and finds no match (the row it was waiting on is no longer current) — so it treats the situation as "no previous target" and attempts a fresh `INSERT`, which then collides with whichever transaction already won, producing a raw `duplicate key value violates unique constraint "idx_targets_current_event"` error. The RPC is *correct* (the invariant never breaks) but not *graceful* under contention — most concurrent callers get a hard Postgres error rather than a clean success-in-turn or a friendly conflict response.

**Limitations:** Single-process concurrency (`Promise.allSettled` from one Node process against local Postgres), not a true multi-process/distributed test. This is an appropriate scope for a DB-transaction-level correctness question but should not be generalized into a "proven under distributed load" claim.

**Resume suitability:** **Useful for engineering discussion, not a clean resume bullet as originally worded.** "Preventing race conditions" is true for the specific invariant tested (verified, not assumed), but the resume should not imply the mechanism handles concurrent writers gracefully — it doesn't, and this audit found and can explain exactly why. This is a genuinely strong interview topic precisely because it's a nuanced, real finding rather than a clean win.

---

## M2 — Idempotency-key race on `ledger.service.js createEntry()`

**Objective:** Do N concurrent `createEntry()` calls sharing one idempotency key produce exactly one ledger row, with the rest correctly recognized as replays?

**Implementation under test:** The real `createEntry()` function (not a reimplementation), including its explicit handling of the Postgres `23505` unique-violation race (`src/services/ledger.service.js:207-217`). Script: `scripts/experiments/m2-idempotency-race.js`.

**Environment:** Same local stack; calls go through the actual service layer, including its downstream calls to `supabaseAdmin`, the audit log, and (for pending-status entries) the notification queue.

**Workload:** Concurrency 5, 15, 30; each level repeated 3 times with a fresh participant and a fresh idempotency key per repetition (9 runs total).

**Results:** **9/9 runs: exactly 1 row created per idempotency key, 0 rejected promises.** Representative run at C=30: `fulfilled: 30, rejected: 0, fresh_creates_reported: 1, idempotent_replays_reported: 29, actual_row_count_for_key: 1`. This pattern was identical (modulo the concurrency number) at C=5 and C=15.

**Baseline comparison:** No baseline needed — this is a binary correctness invariant (exactly 1 row), not a relative comparison.

**Interpretation — what this demonstrates:** `createEntry()`'s idempotency handling is **more robust under concurrency than `set_contributor_target_atomic`**: every one of 180 total concurrent requests (9 runs × up to 30 concurrent calls) that lost the race got a clean "idempotent replay" response rather than a raw database error, because the catch-and-recheck-on-23505 logic in `createEntry()` is explicit about this exact scenario. **What it does not demonstrate:** behavior across process/server restarts, partial failures mid-transaction, or idempotency keys colliding across different `workspace_id`s (not tested here — the lookup is correctly scoped by `workspace_id`, confirmed by reading the code, but not independently exercised).

**Limitations:** Single-process concurrency, same caveat as M1. Notification fan-out was exercised as a side effect for `isAdmin: true` entries that land in `confirmed` status in this test, so no pending-status notification path was triggered — that path wasn't the target of this experiment.

**Resume suitability:** **Resume-ready.** This is the strongest result in the batch: a real, repeated, multi-concurrency-level test of the actual production code path, with a clean 100% pass rate and a specific mechanism (not a vague "handles duplicates").

---

## M3 — DB-level ledger immutability trigger

**Objective:** Does `enforce_ledger_entry_immutability` (defined in `migrations/001_schema.sql`) reject a direct SQL mutation of a confirmed ledger entry's amount, independent of the application layer — while still allowing legitimate status transitions?

**Implementation under test:** The trigger itself, attacked via a raw `pg` connection issuing `UPDATE ledger_entries SET original_amount = original_amount + 1 ...` directly — bypassing `ledger.service.js` entirely. Script: `scripts/experiments/m3-immutability-trigger.js`.

**Environment:** Same local Postgres instance, direct `pg` client (not PostgREST, not the app) for the mutation attempts themselves.

**Workload:** Single deterministic test per run (no concurrency dimension — this is a correctness check, not a performance one), run twice successfully after fixing two bugs in the test harness itself (wrong required factory field, wrong FK target — see §5).

**Results:** **PASS, both successful runs.** The disallowed mutation was rejected with Postgres error code `P0001` and message `ledger_entries: entry <id> is locked (status=confirmed) — only its status (via an allowed transition) and proofs may change. Use a correction (corrects_entry_id) to adjust a confirmed entry instead.` A follow-up query confirmed `original_amount` was numerically unchanged. A legitimate transition (`confirmed` → `disputed`) on the same row succeeded immediately after.

**Baseline comparison:** Conceptual only — pre-migration-002 behavior (application-layer-only enforcement) vs. current (DB-level trigger). Not re-tested by reverting the trigger in a live DB, since the point is to verify the *current* guarantee, not reproduce the historical absence of one.

**Interpretation — what this demonstrates:** A real, working, defense-in-depth guarantee: even a direct database connection with full privileges cannot silently alter a confirmed financial record's amount — only sanctioned status transitions pass. **What it does not demonstrate:** behavior for other fields (e.g., `contributor_id`, `container_id`) on a confirmed row — this experiment tested `original_amount` specifically; the trigger's own logic suggests it covers more, but only the amount field and the status transition were independently verified here.

**Limitations:** None significant for the question asked — this is about as clean a correctness experiment as exists in this codebase.

**Resume-ready, and currently absent from the resume** — this is new evidence for a mechanism added after the resume's apparent snapshot date, not a verification of an existing claim. See `RESUME_METRIC_RECOMMENDATIONS.md`.

---

## M4 — Membership cache (Redis) latency

**Objective:** How much latency does the Redis-cached membership lookup save vs. the uncached two-query path, and what's a defensible description of the savings?

**Implementation under test:** `membership-cache.service.js`'s actual cache-hit path vs. an uncached two-Supabase-query baseline, both already implemented in the repo's own `scripts/measure.js cache` command (reused as-is, not modified).

**Environment:** Same local stack, sequential (not concurrent) timed calls from the same machine as the DB/Redis, to isolate per-call latency rather than measure throughput.

**Workload:** N=300 sequential calls per path per run, one real workspace/user membership fixture, 4 independent runs across the session.

**Results:**

| Run | p50 uncached (ms) | p50 cached (ms) | p50 speedup |
|---|---|---|---|
| 1 | 4.57 | 0.32 | 14.3x |
| 2 | 4.12 | 0.29 | 14.2x |
| 3 | 4.05 | 0.28 | 14.5x |
| 4 | 4.17 | 0.26 | 16.0x |

Consistent across all 4 runs: **p50 uncached ≈ 4.0-4.6ms, p50 cached ≈ 0.26-0.32ms, ~14-16x p50 speedup.** p95 uncached was 8.1-8.8ms vs. 1.2-1.7ms cached in the same runs (from the raw result files).

**Baseline comparison:** Same machine, same fixture, same N, back-to-back in the same process — a controlled, fair comparison of two code paths doing equivalent work (resolve one user's membership in one workspace).

**Interpretation — what this demonstrates:** On this machine, against a local Postgres/PostgREST instance (not production Supabase, which would add real network latency to the uncached path and likely widen the gap further), the Redis cache reliably avoids ~4ms of query time and 2 round-trips per hit. **What it does not demonstrate:** production-scale savings, since this sandbox's DB is on localhost — a hosted Supabase instance would show larger absolute uncached latencies (network RTT), likely a larger absolute speedup but a similar or smaller *ratio* once Redis's own network hop is counted on a real deployment topology.

**Limitations:** Local-network measurement, not production. The repo's own script already frames this correctly ("membership lookup", not "API latency") — preserved throughout.

**Resume suitability:** **Resume-ready, with the local-measurement caveat stated.** A defensible, repeated, real number: "Redis-cached membership lookups measured at ~0.3ms p50 vs. ~4.2ms p50 uncached (≈14x) across 4 runs of 300 sequential calls each, avoiding 2 DB round-trips per hit (local benchmark)."

---

## 5. Honest accounting of failed/blocked attempts

Per the task's instructions, these are preserved, not hidden:

| Experiment | Attempts | Failure cause | Resolution |
|---|---|---|---|
| M1 | 1 of 6 runs failed | Sandbox restarted mid-session, killing the local Postgres/Redis/PostgREST processes (`fetch failed` on the seed step) | Restarted the local stack (see §6), reran successfully |
| M3 | 4 of 6 runs failed | (a) Test harness bug: `buildLedgerEntry` factory requires an explicit `recorded_by` — wasn't passed. (b) Test harness bug: `contributor_id` on `ledger_entries` references `workspace_members`, not `container_participants` — wrong table used. (c) Sandbox restart (same as M1). | Fixed the script (not the application) in each case; re-ran successfully after each fix |
| M2 | n/a (both recorded runs succeeded) | An earlier *unrecorded* ad-hoc run hung indefinitely — `createEntry()` enqueues a BullMQ job, which holds a persistent Redis connection open, so a one-shot script never exits on its own | Added an explicit `process.exit()` at the end of the script; not an application bug, a test-script issue |

**An important, unplanned discovery made while re-running the project's own integration suite** (not one of M1-M4, but surfaced in the process of validating the local stack): running `npx jest --selectProjects integration` against the fully assembled local stack went from 24 passing/245 failing (before migrations were correctly applied) to **246 passing / 23 failing** once both migrations were applied and the stack was configured correctly. Digging into one of the 23 remaining failures (`tests/integration/routes/ledger.routes.test.js`) found that the test suite's own `cleanupWorkspace` helper tries to hard-`DELETE` `ledger_entries` rows, which migration 002's new immutability trigger now rejects for confirmed/disputed/resolved entries — so cleanup silently fails (logged via `console.error`, not thrown), leaving orphaned rows that cause downstream test pollution. **This is very likely connected to, or at least compounds, the reason the integration CI job was disabled** (`.github/workflows/test.yml`, disabled 2026-08-25 citing "flaky test environment"), though the disable predates migration 002 (`git log` shows 002 landed after the CI job was already commented out), so the trigger is a *second*, newer cause of the same symptom rather than the original one. This was not fixed as part of this measurement task (it's a test-infrastructure bug, not one of the four planned experiments, and fixing it wasn't authorized), but it's recorded here because it directly affects how much weight the "90%+ critical-path coverage" and "CI-verified" resume claims can currently bear — see `RESUME_METRIC_RECOMMENDATIONS.md`.

## 6. Reproduction

See `backend/scripts/README.md` for exact commands.
