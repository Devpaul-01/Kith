# ADR-0013: BullMQ with One Queue Per Job Type for Scheduling

**Status:** Accepted (supersedes an earlier "central scheduler queue"
design)

## Context

The application needs recurring, cron-scheduled background work: a daily
reminder scan, daily cycle-lifecycle transitions (opening/closing recurring
payment cycles), a daily task-overdue check, daily invite cleanup, a weekly
engagement check, daily cycle-generation maintenance, and a five-minute
notification-outbox safety-net scan.

An earlier design registered repeatable jobs onto a separate,
purpose-built scheduler queue while the actual workers listened on their
own per-concern queues — a structural mismatch, since a repeatable job
lives inside whichever queue it was registered on, and when its cron
fires, BullMQ enqueues the resulting job into that same queue, not into a
separate "scheduler" queue that workers would need to also listen to. The
result was jobs firing into a queue nothing was consuming.

## Problem Statement

How do you register cron-scheduled jobs such that the queue the cron
registers against is *always* the same queue the corresponding worker is
listening on, with no possibility of the two silently drifting apart?

## Decision

`SCHEDULED_JOBS` in `scheduler.js` is an explicit array of `{ jobName,
queueName, cron, data }` entries, one per recurring job, where `queueName`
is always one of the real, worker-backed queue names from
`queues/index.js`'s `QUEUE_NAMES` (e.g. `'reminder-queue'`, never a
generic dispatcher queue). `setupScheduler()` iterates this array and, for
each entry, creates a `Queue` instance for `queueName` directly and calls
`queue.add(jobName, data, { repeat: { cron }, jobId:
'scheduled:${jobName}' })` — registering the repeatable job on the exact
queue the matching `Worker` (in `background.workers.js`) listens to.

Idempotent registration: before adding, it fetches existing repeatable
jobs on that queue and removes any with a matching `name`, so restarts
don't accumulate duplicate schedules. The stable `jobId:
'scheduled:${jobName}'` provides a second layer of duplicate protection.

`getAllQueues()` (`queues/index.js`) throws on any queue name not
explicitly listed in `QUEUE_NAMES`, preventing typo-based queue
proliferation — a queue can only be requested by a name that's already
been deliberately registered, closing off the exact class of naming-drift
issue at the queue-registry level too.

## Alternatives Considered

- **One central "scheduler" queue with a dispatcher worker that routes
  jobs to the right handler.** Rejected in favor of the current design —
  routing responsibility living in a place (a central queue) disconnected
  from where the actual work happens (per-concern workers) allows the two
  to silently drift out of sync with no error, only silent
  non-processing.
- **A single worker handling all scheduled job types via a `switch` on job
  name.** Would avoid the queue-name-matching problem entirely (one
  queue, one worker, dispatch internally) but would abandon the per-
  concern worker separation the rest of the codebase relies on (each
  worker file — `reminder`, `cycleGeneration`, `cycleLifecycle`,
  `taskOverdue`, etc. — maps 1:1 to a service file, matching the
  controller/service convention from ADR-0002) and would make concurrency
  tuning per job type (e.g. `cycle-generation-queue`'s `concurrency: 5`
  vs. `reminder-queue`'s `concurrency: 1`) impossible to express per queue.

## Rationale

Every worker exported by `background.workers.js` that has a cron schedule
registered in `queues/scheduler.js` must be instantiated and added to the
`workers` array in each runtime entry point, or the corresponding
safety-net job fires into its queue on schedule with nothing listening on
it. This is the same failure mode as the original scheduler design issue,
but at the worker-instantiation layer rather than the queue-naming layer —
the same class of "produces without a consumer" mistake is possible at two
different points in the pipeline, and both are explicitly guarded against.

## Trade-offs

- The `queueName` in each `SCHEDULED_JOBS` entry and the queue string a
  `Worker` is constructed against in `background.workers.js` are two
  separately-written string literals that must match exactly — there's no
  shared constant enforcing this at the type level (no TypeScript, no
  shared enum import between the two files), so the invariant is
  maintained by convention and code review.
- Running `setupScheduler()` from more than one active process
  simultaneously (e.g. if both `start-all.js` and a standalone
  `workers/index.js` ran concurrently against the same Redis) would
  redundantly re-register the same repeatable jobs — safe due to the
  stale-job-removal-before-add logic, but wasteful.

## Consequences

- `scheduler.js` can be run completely standalone
  (`node src/queues/scheduler.js`) purely to *register* schedules without
  processing any jobs — useful for one-off schedule updates — while the
  actual job processing happens wherever the matching workers are running
  (`start-all.js` or `workers/index.js`), decoupling "who registers the
  cron" from "who executes the resulting job."
- Every scheduled job in `SCHEDULED_JOBS` has a corresponding worker
  factory function in `background.workers.js`, and every worker factory
  is called in both `workers/index.js` and `start-all.js` — an explicit,
  checkable relationship among the schedule table, the worker factories,
  and the two runtime entry points that instantiate them (see ADR-0001).

## Related Files

- `src/queues/scheduler.js`
- `src/queues/index.js` (`QUEUE_NAMES`, `getQueue`, `getAllQueues`)
- `src/workers/background.workers.js`
- `src/workers/index.js`
