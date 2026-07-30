# Kith Backend — Testing Setup

This README walks through running the integration test suite from
scratch. It assumes no prior experience with integration testing.

## What you need installed first

- **Node.js** (v18 or newer) — https://nodejs.org
- **Docker Desktop** (or Docker Engine + Docker Compose on Linux) —
  https://www.docker.com/products/docker-desktop
- **PostgreSQL client tools** (just the `psql` command, for loading the
  schema) — on Mac: `brew install libpq && brew link --force libpq`; on
  Ubuntu/Debian: `sudo apt install postgresql-client`; on Windows,
  install via the official PostgreSQL installer and ensure `psql` is on
  your PATH.

Check these are all working:
```bash
node --version    # should print v18.x or higher
docker --version
psql --version
```

## One-time setup

1. Install project dependencies:
   ```bash
   npm install
   ```

2. Start the test database and Redis (this uses `docker-compose.test.yml`,
   already included):
   ```bash
   npm run test:docker:up
   ```
   This brings up three containers: a test Postgres database, PostgREST
   (a small REST API layer in front of it — this project's Supabase
   client library talks to Postgres through this, not directly), and a
   test Redis instance. Give it about 10-15 seconds to fully start.

3. Load the database schema into the test database:
   ```bash
   npm run test:docker:seed
   ```
   If this fails with a connection error, wait a few more seconds for
   Postgres to finish starting up and try again.

That's it for one-time setup. You only need to repeat steps 2-3 if you
tear the containers down (`npm run test:docker:down`) or restart your
machine.

## Running the tests

**Integration tests** (the main suite — routes, Redis, background jobs):
```bash
npm run test:integration
```

**Rate-limiting tests** (kept separate on purpose — see
`tests/setup.ratelimit.js` for why):
```bash
npm run test:ratelimit
```

**Unit tests** (written separately — only relevant once that suite
exists under `tests/unit/`):
```bash
npm run test:unit
```

## Shutting down

When you're done testing, tear down the Docker containers:
```bash
npm run test:docker:down
```
This also wipes the test database, so you'll need to re-run
`npm run test:docker:seed` next time you bring it back up.

## If something goes wrong

- **"Connection refused" errors**: the Docker containers probably
  aren't up yet, or aren't fully ready. Run `docker ps` to confirm all
  three containers (`postgres-test`, `postgrest-test`, `redis-test`) are
  listed as running, then wait a bit longer.
- **Tests hang or time out**: check `docker logs postgrest-test` — if
  PostgREST can't reach Postgres, it'll fail silently from the test's
  point of view. Restarting via `npm run test:docker:down` followed by
  `npm run test:docker:up` usually resolves this.
- **A schema-related error** (e.g. "relation does not exist"): the
  schema didn't load — re-run `npm run test:docker:seed`.
- **Port already in use**: something else on your machine is already
  using port 54322, 3001, or 63790. Either stop that other process, or
  edit the port numbers in `docker-compose.test.yml` (and the
  corresponding `TEST_SUPABASE_URL`/`TEST_REDIS_URL` env vars if you do).

## CI (GitHub Actions)

`.github/workflows/test.yml` runs the same steps automatically on every
push and pull request to `main`/`develop`. It spins up its own fresh
Postgres/Redis/PostgREST, loads the schema, runs unit tests (if present),
then integration tests, then rate-limit tests — no manual setup needed
there, it's all automated.

## Project structure

```
migrations/001_schema.sql      — the full database schema (tables, RPC functions)
docker-compose.test.yml        — test Postgres + PostgREST + Redis
tests/
  setup.unit.js                — env config for unit tests (mocked DB/Redis)
  setup.integration.js         — env config for integration tests (real DB/Redis)
  setup.ratelimit.js           — env config for the rate-limit suite specifically
  mocks/                       — shared mock modules (Supabase, Redis, Firebase, Resend, BullMQ)
  helpers/                     — shared test helpers (auth, DB seeding, time control)
  fixtures/factories/          — factory functions for building test data
  integration/
    routes/                   — one file per API route group
    redis/                    — Redis-specific behavior tests
    workers/                  — background job tests
    queues/                   — scheduler + queue wiring tests
  unit/                       — (written by a separate process — not included here)
```

See `DELIVERY_SUMMARY.md` for a full breakdown of what each test file covers.
