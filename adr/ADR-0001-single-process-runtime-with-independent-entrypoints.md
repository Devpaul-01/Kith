# ADR-0001: Single-Process Runtime with Independent Entry Points

**Status:** Accepted

## Context

The application has three logical runtime concerns: the HTTP API, a set of
BullMQ background workers (notifications, reminders, cycle generation/
lifecycle, task-overdue checks, invite cleanup, engagement checks, data
export, notification outbox), and a cron-style scheduler that registers
repeatable BullMQ jobs. In a production deployment these are typically
scaled independently — the API needs to scale with request volume, workers
need to scale with job volume, and the scheduler only ever needs one active
registrant.

At the same time, local development and small deployments don't benefit
from that separation and pay a real cost for it: three processes to start,
three sets of logs to watch, three graceful-shutdown paths to get right.

## Problem Statement

How do you support both "run this as three independently-scalable
processes in production" and "run this as one command locally" without
duplicating business logic or maintaining two different bootstrapping
implementations?

## Decision

Three entry points exist side by side:

- `src/server.js` — HTTP API only. Validates environment, initializes
  Sentry, checks DB/Redis connectivity, starts Express, and wires
  `SIGTERM`/`SIGINT` graceful shutdown.
- `src/workers/index.js` — worker process only. Loads all BullMQ workers
  (notification, reminder, cycle generation, cycle lifecycle, task overdue,
  invite cleanup, engagement check, data export, notification outbox) plus
  the scheduler, with per-worker event logging and its own shutdown path.
- `src/start-all.js` — a composed runtime that starts the Express app *and*
  every worker *and* the scheduler in one Node process, under one shared
  graceful-shutdown handler.

`start-all.js` is a single-process runner intended for local development
and small deployments. `server.js` and `workers/index.js` remain fully
independent and work standalone; `start-all.js` simply gives a single
command for local use.

`package.json`'s `main` field and `start`/`dev` scripts point at
`start-all.js`, making the combined runtime the default, while `worker` and
`scheduler` scripts exist separately for anyone who wants to split the
process out.

## Alternatives Considered

- **Only ever run as three separate processes.** Rejected for local
  development ergonomics — running the project for the first time
  shouldn't require three terminal tabs and three `.env`-reads before
  anything works.
  <br>
- **Only ever run as one process.** Rejected for production: workers are
  I/O- and CPU-bound in different ways than the HTTP layer (e.g. cycle
  generation loops, CSV export, file-signature verification), and coupling
  their scaling to API request volume would either starve the API under
  worker load or over-provision API replicas just to get more worker
  throughput.
  <br>
- **A single "mode" entry point with a `--mode=api|worker|all` flag.**
  Would have achieved the same result with one file instead of three, but
  at the cost of one file doing three jobs with conditional branches
  throughout. The chosen approach keeps each entry point single-purpose and
  lets `start-all.js` simply *compose* the other two conceptually (it
  duplicates their bootstrapping rather than importing them directly, but
  keeps the actual worker-creation functions and route table imported from
  the same modules `server.js` and `workers/index.js` use).

## Rationale

Business logic never lives in any of the three entry-point files — they
only call into `services/*.js`, `workers/*.worker.js`, and
`workers/background.workers.js`. That means the "three-entry-points"
decision is purely a bootstrapping/composition concern, not a logic-
duplication one, which is what makes maintaining three files acceptable
here.

## Trade-offs

- `start-all.js` duplicates the environment-validation and
  Sentry-initialization blocks that also appear in `server.js` (and, in
  spirit, in `workers/index.js`). A shared `bootstrap.js` could remove this
  duplication, at the cost of one more layer of indirection for what is
  currently ~15 lines of straightforward, easy-to-read setup code repeated
  three times.
- Running `start-all.js` in production would put HTTP request handling and
  background job processing in the same event loop and process memory
  space, which is explicitly *not* the intended production topology.

## Consequences

- Local development and CI can run the entire system with `npm start`
  (`node src/start-all.js`), with one shared shutdown path
  (`server.close()` then `Promise.race` over `worker.close()` calls with a
  10-second forced-exit fallback).
- Production deployments can run `server.js` as an API deployment and
  `workers/index.js` as a separate worker deployment, scaled independently,
  without any code changes — both files already exist and are already
  wired to the same services.
- `scheduler.js` is safe to invoke from either `workers/index.js` or
  standalone (`node src/queues/scheduler.js`) because it is idempotent by
  design (see ADR-0013) — repeated registration removes stale repeatable
  jobs by name before re-adding them.

## Related Files

- `src/server.js`
- `src/start-all.js`
- `src/workers/index.js`
- `src/queues/scheduler.js`
- `package.json` (`scripts.start`, `scripts.worker`, `scripts.scheduler`)
