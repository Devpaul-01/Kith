# Kith — Measurement Infrastructure

Everything here is additive: no file under `backend/src/` or any migration was modified to produce these results. Commit `e647e78306feefdb1cb8712c326f1cb0d20abdd8` is unchanged.

## Layout

```
scripts/
  local-test-stack/
    start.sh            # brings up Postgres+PostgREST+Redis without Docker
    pgrst-proxy.js       # strips /rest/v1 prefix so supabase-js works against bare PostgREST
  seed-measurement-fixtures.js   # one-off: seed a workspace/container/participant, print IDs
  run-and-record.js      # generic wrapper: runs any command, saves timestamped JSON w/ metadata
  experiments/
    m1-target-race.js             # P0: set_contributor_target_atomic concurrency correctness
    m2-idempotency-race.js        # P0: ledger createEntry() idempotency-key race
    m3-immutability-trigger.js    # P0: DB-level ledger immutability trigger
    (M4 reuses the repo's own scripts/measure.js cache command, unmodified)
  results/
    target-race/   idempotency/   immutability/   cache/   # raw timestamped JSON per run
    EXPERIMENT_RESULTS.md          # consolidated analysis — read this first
```

## Why `local-test-stack/` exists instead of `docker-compose.test.yml`

Docker isn't available in every environment (it wasn't in the one used to run these experiments). `local-test-stack/start.sh` assembles the same three services — Postgres, PostgREST, Redis — as native processes instead of containers, applies both migrations, and starts a tiny reverse proxy (`pgrst-proxy.js`) in front of bare PostgREST. The proxy exists because `supabase-js` always targets `${SUPABASE_URL}/rest/v1/...` (the path a hosted Supabase project's gateway expects); a bare `postgrest/postgrest` binary serves routes at the schema root instead. The proxy strips the prefix so the app and test suite work completely unmodified. **Where Docker is available, prefer `docker-compose.test.yml` directly — `local-test-stack/` is a fallback, not a replacement.**

## One-time setup (if Docker isn't available)

```bash
sudo apt-get update && sudo apt-get install -y postgresql redis-server
# PostgREST v12.0.2 (matches docker-compose.test.yml):
curl -sL -o /tmp/postgrest.tar.xz \
  https://github.com/PostgREST/postgrest/releases/download/v12.0.2/postgrest-v12.0.2-linux-static-x64.tar.xz
tar xf /tmp/postgrest.tar.xz -C /tmp && chmod +x /tmp/postgrest
cd backend && npm install
```

## Bring the stack up (every session — it does not persist across a full environment restart)

```bash
bash backend/scripts/local-test-stack/start.sh
```

This is idempotent: safe to re-run, skips anything already running, creates+migrates `kith_test` only if it doesn't already exist.

## Run an experiment

```bash
cd backend
cp .env.measurement .env   # points SUPABASE_URL/REDIS_URL at the local stack

# M1 — target-race concurrency correctness (takes ~5s)
node scripts/run-and-record.js M1_target_race target-race -- \
  node scripts/experiments/m1-target-race.js

# M2 — idempotency-key race (takes ~15-25s; createEntry() enqueues a
# notification job, which is why the script force-exits at the end)
node scripts/run-and-record.js M2_idempotency_race idempotency -- \
  node scripts/experiments/m2-idempotency-race.js

# M3 — DB-level immutability trigger (takes ~2s, deterministic)
node scripts/run-and-record.js M3_immutability_trigger immutability -- \
  node scripts/experiments/m3-immutability-trigger.js

# M4 — membership cache latency (the repo's own existing harness; needs
# a real workspace/user pair — seed one first)
node scripts/seed-measurement-fixtures.js   # prints WORKSPACE_ID / USER_ID / etc.
WORKSPACE_ID=<printed-id> USER_ID=<printed-id> \
  node scripts/run-and-record.js M4_membership_cache cache -- \
  node scripts/measure.js cache 300
```

Every invocation writes a fresh, timestamped JSON file under `scripts/results/<subdir>/` — nothing is ever overwritten. Each file records: experiment name, run ID, UTC start/end time, git commit SHA + branch + dirty flag, Node version, OS/CPU/memory, the exact command run, exit code, and full stdout/stderr.

## Read the results

`scripts/results/EXPERIMENT_RESULTS.md` is the consolidated, human-readable analysis (objective/method/results/interpretation/limitations/resume-suitability per experiment, plus an honest log of every failed attempt and why). The raw JSON files are the underlying evidence trail if you need to check a specific number.

## Cleanup

```bash
redis-cli -p 6379 flushdb
redis-cli -p 63790 flushdb
PGPASSWORD=test psql -h localhost -p 5432 -U postgres -d kith_test -c "TRUNCATE workspaces CASCADE;"
```

Dropping the whole `kith_test` database and re-running `start.sh` also works and is simpler if you don't need to keep any seeded data.
