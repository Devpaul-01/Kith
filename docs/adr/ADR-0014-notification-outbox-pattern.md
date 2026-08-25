# ADR-0014: Template Registry, Dedup, and Outbox Pattern for Notifications

**Status:** Accepted

## Context

Notifications in this system fan out across up to three channels
(`in_app`, `push`, `email`) for a wide variety of events — contribution
submissions/confirmations/disputes, task assignments/completions/overdue
alerts, cycle lifecycle events, admin announcements, member removal, and
more (sixteen distinct types registered in `TEMPLATES`). Each channel has
a different delivery mechanism (an immediate DB write for `in_app`, FCM for
`push`, Resend for `email`), a different failure mode, and — critically —
sending the *same* notification twice to a user is a real product problem
(e.g. a duplicate "cycle closing soon" reminder), not just noise.

## Problem Statement

How do you support multi-channel notification delivery with (a) one place
that defines what each notification type says, (b) protection against
sending logically-duplicate notifications, and (c) resilience against a
transient failure in enqueueing a delivery job silently losing that
delivery forever?

## Decision

Three cooperating pieces, kept in three separate files by design:

1. **A central template registry and sender**
   (`services/notification.service.js`). `TEMPLATES` maps a notification
   `type` to a `{ title, body, channels, urgent? }` definition;
   `renderTemplate()` does simple `{variable}` interpolation.
   `send({ type, workspaceId, recipientIds, variables, dedupKey })` is the
   single mandatory entry point — every notification in the system routes
   through it. For each recipient, it resolves their contact info, inserts
   a `notifications` row via `upsert(..., { onConflict: 'dedup_key',
   ignoreDuplicates: true })` — deduplication is enforced at the database
   level via a unique constraint on `dedup_key`, not just in application
   logic — and, for external channels, enqueues a delivery job per
   channel. `buildDedupKey()` derives a default key from
   `participant_id`/`container_id`/`due_date`/`days`/`cycle_id` when the
   caller doesn't supply one explicitly.
2. **A distinct inbox service** (`notification_inbox.service.js`),
   deliberately not merged into the sender file — it's a separate concern
   of a recipient reading/managing their own inbox, kept apart from the
   central sender that nearly every other service imports.
3. **A distinct delivery worker** (`notification_delivery.service.js`,
   wired by `notification.worker.js`), which actually sends via FCM/Resend,
   with its own idempotency check (skip if `notification_deliveries.status
   === 'delivered'` already) and a token-rotation guard (verify the FCM
   push token stored on the job payload still matches the user's *current*
   token before sending, skipping if it's since rotated).
4. **An outbox safety net** (`notification_outbox.service.js`, run every 5
   minutes via the scheduler — see ADR-0013). It scans for
   `notification_deliveries` rows stuck in `pending` or `failed` for more
   than 5 minutes (external channels only — `in_app` is excluded since
   it's synchronously resolved) and re-enqueues them. This exists
   specifically to cover the case in `notification.service.js` where
   `notificationQueue.add(...)` itself throws (a queue-level failure, not
   a delivery-level one) — if the enqueue fails, the delivery record stays
   as `pending` so the outbox worker can pick it up and retry.

## Alternatives Considered

- **One file for send + inbox + delivery.** Rejected — the naming for
  `notification_inbox.service.js` is deliberately distinct from
  `notification.service.js` specifically to keep these concerns from
  merging by accident.
- **Rely solely on BullMQ's own retry/backoff for delivery failures.**
  BullMQ retry *is* used (`attempts: 3, backoff: { type: 'exponential',
  delay: 5000 }` on the delivery job itself), but this only covers
  failures *after* a job is successfully enqueued. The outbox scan exists
  specifically for the failure mode BullMQ's own retry can't cover: the
  `queue.add()` call itself throwing before a job ever exists to retry.
- **No deduplication, or application-only (non-DB-enforced) dedup.** The
  `notifications` table's unique constraint on `dedup_key` means dedup is
  enforced even under concurrent calls to `send()` for the same logical
  event — an application-level-only check (e.g. "query then insert if not
  found") would have the same race-condition risk that motivated the
  RPC-based atomic operations in ADR-0010.

## Rationale

`reminder.service.js` demonstrates the dedup key's purpose concretely: it
sends payment reminders, overdue reminders, admin overdue summaries, and
cycle-closing-soon reminders, all as *daily scheduled scans* that could
easily re-fire the same logical reminder on every run if not deduplicated.
Every call site there passes an explicit `dedupKey` incorporating the scan
date (e.g. `` `overdue_reminder:${target.id}:${scanDate}` ``), so a reminder
already sent today is a guaranteed no-op on a subsequent scan the same
day, rather than relying on timing or scan-frequency tuning to avoid
duplicates.

The same file also demonstrates why templates need a registry rather than
being written ad hoc at each call site: it sends two templates
(`overdue_summary_admin`, `cycle_closing_soon`) that were defined in the
registry well before their sending logic existed — meaning the registry
had already specified a notification's shape before its sending logic
existed, and the sending logic was added later without needing to touch
the template definition at all.

## Trade-offs

- Four files (`notification.service.js`,
  `notification_inbox.service.js`, `notification_delivery.service.js`,
  `notification_outbox.service.js`) plus the worker wiring, for what is
  conceptually "send and read notifications" — more moving parts than a
  single monolithic notification module, in exchange for each piece being
  independently testable and independently scalable (the delivery worker
  runs with `concurrency: 10` and a `limiter: { max: 50, duration: 1000 }`,
  tuned differently than, say, the outbox scan's `concurrency: 1`).
- The outbox scan is a polling mechanism (every 5 minutes) rather than an
  event-driven guarantee — a failed enqueue can sit for up to 5 minutes
  before being retried, which is an accepted latency cost for the
  reliability it buys.

## Consequences

- Proxy members (`is_proxy: true`) are explicitly excluded from
  external-channel notifications at multiple layers independently — in
  `notification.service.js#_sendToRecipient` (`if (recipient.is_proxy &&
  channel !== 'in_app') continue`) *and* again in
  `notification_outbox.service.js` (`if (recipient?.is_proxy) continue`)
  — meaning this business rule is enforced redundantly at both the initial
  send path and the outbox-recovery path, kept intentionally in sync
  across both.
- Any new notification type only requires adding one entry to `TEMPLATES`
  and calling `notification.send(...)` from wherever the triggering event
  lives — the delivery, dedup, retry, and outbox-recovery mechanics are
  entirely reusable with zero new code.

## Related Files

- `src/services/notification.service.js`
- `src/services/notification_inbox.service.js`
- `src/services/notification_delivery.service.js`
- `src/services/notification_outbox.service.js`
- `src/services/reminder.service.js` (heaviest real-world consumer of
  `dedupKey`)
- `src/workers/notification.worker.js`
