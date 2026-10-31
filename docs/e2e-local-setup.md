# Running the Playwright E2E suite locally

The E2E suite (`frontend/e2e/`) drives the real frontend against a real
running backend and a real Supabase-compatible stack — no mocks, no
seeded-JWT auth bypass. Signup and login go through the actual UI forms
and the actual GoTrue-compatible auth flow.

## Why not `docker-compose.test.yml`?

That setup is correct for the backend's own unit/integration tests,
but it starts bare PostgREST with no Supabase API gateway in front of
it, so `supabase-js`'s `/rest/v1/*` requests 404. It also has no auth
service at all (GoTrue), so a real signup/login round-trip isn't
possible against it. The integration tests work around this by mocking
`supabaseAdmin.auth.getUser()` — fine for testing backend logic in
isolation, not fine for an E2E suite that needs the real thing.

## What this setup uses instead

[`@supabase/lite`](https://www.npmjs.com/package/@supabase/lite) — an
official, npm-distributed local Supabase implementation (PostgREST and
GoTrue compatible, backed by an embedded Postgres via `pglite`) that
`supabase-js` can talk to exactly as it would talk to a hosted Supabase
project. One process gives you Postgres + REST + Auth together.

### 1. Set up the local Supabase stack

```bash
mkdir -p e2e-local && cd e2e-local
npm init -y
npm install @supabase/lite
npx lite init --pglite       # generates ./supabase and a fresh .env with API keys
```

Copy the real schema in and generate a migration from it:

```bash
cp ../migrations/001_schema.sql ./supabase/schemas/schema.sql
npx lite db diff -f kith_schema
npx lite migration up
```

Start it:

```bash
npx lite start
# ➜ Server running on http://127.0.0.1:54321
# ➜ Publishable key    sb_publishable_...
# ➜ Secret key         sb_secret_...
```

Keep the printed keys — you'll need them for both the backend and
frontend `.env` files below.

If `lite start` crashes with a pglite `RuntimeError: Aborted()`, it's
almost always a stale lock from an unclean shutdown. Remove
`./supabase/.temp/data/postmaster.pid` and start it again; your schema
and data are untouched.

### 2. Point the backend at it

In `backend/.env`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<the publishable key printed above>
SUPABASE_SERVICE_ROLE_KEY=<the secret key printed above>
REDIS_URL=redis://localhost:6379/0
# ...the rest of backend/.env.example
```

Start Redis and the backend as usual (`node src/start-all.js` or
`npm run dev`).

### 3. Point the frontend at it

In `frontend/.env`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<the same publishable key>
VITE_API_BASE_URL=http://localhost:3000
```

Start it: `npm run dev` (serves on `http://localhost:5173`).

### 4. Get a Chromium binary, if Playwright's own download is blocked

In network-restricted environments (some CI runners, sandboxes),
`npx playwright install` can't reach Playwright's browser CDN. If
that's the case:

```bash
npm install -D @sparticuz/chromium
node -e "require('@sparticuz/chromium').default.executablePath().then(console.log)"
```

That prints a path to a real, working Chromium binary (extracted from
the npm package on first use). Pass it to the test run:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/from/above npx playwright test
```

If your environment *can* reach Playwright's CDN, skip this — just run
`npx playwright install chromium` once and leave
`PLAYWRIGHT_CHROMIUM_PATH` unset.

### 5. Run the suite

```bash
cd frontend
npx playwright test
```

## Known gaps in this local stack

- `@supabase/lite` is alpha software and its relationship-embedding
  resolver behaves slightly differently from real PostgREST in at
  least one case we found (see the PGRST201 fixes in
  `backend/src/services/*.js`) — those turned out to be real bugs
  confirmed against PostgREST's documented behavior, not artifacts of
  this tool, but worth knowing this stack is a close approximation,
  not a bit-for-bit match to hosted Supabase.
- OAuth providers (Google sign-in, etc.) aren't exercised by this
  setup.
