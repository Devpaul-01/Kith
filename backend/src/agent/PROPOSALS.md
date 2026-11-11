# Notification proposals

The first agent writes are Tier 2 `mark_notification_read` and
`mark_all_notifications_read`, scoped to the caller's notifications in the
current workspace. The backend requires a proposal and a separate approval
request. Chat text and model tool calls cannot execute either write. Other
writes remain unavailable.

## Select and propose

After the user explicitly selects a notification in their workspace inbox,
send its ID with the chat message:

```json
{
  "message": "Mark the selected notification as read.",
  "selected_notification_id": "<notification-uuid>",
  "conversation_id": null
}
```

Use the existing authenticated `POST /v1/workspaces/:workspaceId/agent/chat`.
The server rereads active membership and the notification. Another recipient's
notification, another workspace's notification and missing notifications return
the same not-found response. An already-read selection is rejected. Fresh
membership checks reject role changes, removed memberships and deleted
workspaces even if the HTTP membership cache is stale.

Only this selected request offers `mark_notification_read` to the model. Its
arguments must be `{}`: the model cannot choose or change an ID. A UUID in
chat text is not a selection, and selection is never inherited from history.
Until a general selection flow exists, clients must obtain explicit selection
separately; the backend does not guess from titles or partial lists.

`mark_all_notifications_read` is offered on authenticated chat turns without
a client-supplied target. It may be called only when the user explicitly asks
to mark all current unread notifications read, and its arguments must also be
`{}`. When the card is created, the server snapshots up to 100 exact unread
notification IDs. The model cannot provide or amend that set. Notifications
created afterward are not part of the proposal and stay unread. An empty set
or a set larger than 100 is rejected without creating a proposal; the normal
notification inbox remains available for larger bulk actions.

When requested by the model, the server reads the required current state,
persists and audits a proposal, then ends the turn. A proposal tool call must
appear alone, not in a batch of reads or proposals. Chat can also return a
normal text reply without proposing anything.

The response's existing `data` object gains `proposal`:

```json
{
  "id": "<proposal-uuid>",
  "tool": "mark_notification_read",
  "tier": 2,
  "summary": "Mark the selected notification as read.",
  "parameters": { "notification_id": "<notification-uuid>" },
  "before": {
    "id": "<notification-uuid>",
    "type": "task.assigned",
    "title": "Your task is ready",
    "is_read": false,
    "read_at": null,
    "created_at": "2026-11-09T12:00:00.000Z"
  },
  "after": { "is_read": true },
  "expires_at": "<server-generated-ISO-timestamp>"
}
```

The title is untrusted display text. Summary and before/after fields come from
server code and domain reads, not model prose. Notification bodies, delivery
data, recipient IDs and audit request metadata are excluded from the card.
For SSE, the card appears in `done.data.proposal`, after conversation storage
when requested. A partial stream is neither a proposal receipt nor approval.
Frontend selection and approval controls are not part of this backend change.

A mark-all card instead contains the server-selected IDs and exact count:

```json
{
  "id": "<proposal-uuid>",
  "tool": "mark_all_notifications_read",
  "tier": 2,
  "summary": "Mark 2 currently unread notifications as read.",
  "parameters": { "notification_ids": ["<uuid-1>", "<uuid-2>"] },
  "before": { "unread_count": 2 },
  "after": { "unread_count": 0 },
  "expires_at": "<server-generated-ISO-timestamp>"
}
```

## Approve or reject

Send a distinct authenticated POST with an empty JSON body `{}` to:

```text
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/approve
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/reject
```

Both routes share the agent's per-user request limiter and never call the
model. They reject parameter, identity, tier and tool overrides. Approval uses
the saved parameters, rereads membership, audits the approval, verifies the
bound state and calls the notification domain service. For one notification,
changes to the reviewed title/type/date/read state invalidate the proposal and
the conditional update cannot rewrite an existing read timestamp. For mark-all,
every saved ID must still exist, belong to the same recipient/workspace and be
unread before execution. The update filters on only those IDs and then verifies
that every target is read. A target concurrently read elsewhere is already in
the desired final state; a later notification is never included.

Approval returns `{ data: { proposal_id, status: "executed", result } }`.
The single-notification result contains `notification_id`, `is_read: true` and
the database's stored `read_at`. The mark-all result contains the bound
`notification_count` and the actual `updated_count`; the latter can be smaller
when another request read a bound notification during execution. Rejection
returns `{ data: { proposal_id, status: "rejected" } }`.
Repeated successful decisions return the saved receipt; an opposite decision
returns a conflict. Display the decision beside its proposal. Approval does
not call the model or append a conversation turn. Later conversation turns
refresh saved action receipts as described below; current notification facts
still require domain reads. Saying “approve” in chat cannot execute it.
Disconnecting after submitting approval does not revoke it; retry the same
proposal ID to learn its outcome rather than creating a replacement action.

## Read status and continue the conversation

Read a saved receipt without making a decision:

```text
GET /v1/workspaces/:workspaceId/agent/proposals/:proposalId
```

The route requires authentication, fresh active membership and the same
user/member/workspace/role scope as the proposal. It shares the per-user
agent rate limiter and returns `Cache-Control: no-store`. It never calls the
model, writes audit events, renews expiry, repairs an audit or executes an
action. A successful response uses the existing envelope:

```json
{
  "data": {
    "proposal_id": "<proposal-uuid>",
    "tool": "mark_notification_read",
    "notification_id": "<notification-uuid>",
    "status": "executed",
    "expires_at": "<approval-expiry-ISO-timestamp>",
    "checked_at": "<server-check-ISO-timestamp>",
    "result": {
      "notification_id": "<notification-uuid>",
      "is_read": true,
      "read_at": "<stored-database-ISO-timestamp>"
    }
  }
}
```

For `mark_all_notifications_read`, the status response uses
`notification_count` instead of `notification_id`, and an executed result is
`{ "notification_count": 2, "updated_count": 2 }`.

| Status | Meaning |
| --- | --- |
| `pending` | Awaiting approval or rejection. |
| `expired` | The approval deadline passed before execution was claimed. |
| `approval_pending` | Approval processing has started; no saved execution result. |
| `indeterminate` | Execution was claimed; the outcome is unconfirmed, possibly still processing. Never assume success/failure or repeat the action. |
| `rejection_pending` | Rejection processing has started; final auditing/storage is incomplete. |
| `rejected` | Rejected without execution. |
| `failed` | The proposal became stale or its conditional update was refused. |
| `audit_pending` | The mutation result was saved but final auditing/completion is unfinished. Repeating approval can finish this without repeating the write. |
| `executed` | The result and final audit are saved. |

Only `audit_pending` and `executed` include `result`. Expiry does not erase a
recorded outcome. Missing, preparing or differently scoped records return
404; corrupt or unavailable storage returns 503. This endpoint reports a
past action, not the notification's current database state.

When a conversation resumes, server code finds proposal cards only in validated,
correlated calls/results for either supported proposal tool in retained history.
It ignores IDs in user/assistant prose, other tool payloads and old receipt
arrays. The server rechecks membership and compares each complete historical
card with its scoped Redis record, then adds fresh `action_receipts` to this
turn's initial `get_my_context` result, inside the untrusted-data envelope.
This does not offer another model-callable tool or restore notification selection.

Refresh is bounded to eight unique cards; normal follow-ups start with at most
seven previous turns. Whole-turn eviction also bounds how long a proposal can
be refreshed. Receipts alone never carry a reference forward after its original
proposal exchange leaves history. A stateless request or new conversation has
an empty receipt array and does not discover proposals from other conversations.

For a missing, changed or unreadable record, internal conversation context gets
only `{ proposal_id, status: "unavailable", checked_at }`, with no historical
target/result substituted. Membership failures stop the turn before the model
is invoked. Prompts require action claims to use this turn's fresh receipts,
never old cards/receipts or user claims of approval. JSON and SSE follow-ups use
the same refresh path; neither can execute a write.

## Expiry, failures and audit

Pending approval expires five minutes after issuance. Redis retains records
and receipts for 24 hours from issuance, bound to the exact user, membership,
workspace and role. Commands have a one-second deadline. Missing/differently
scoped IDs return `AGENT_PROPOSAL_NOT_FOUND` (404); expired approvals return
`AGENT_PROPOSAL_EXPIRED` (410). Corrupt/unavailable storage returns
`AGENT_PROPOSAL_UNAVAILABLE` (503). There is no memory fallback or rebuilding
of a missing proposal from client data.

Atomic comparisons serialize decisions. `AGENT_PROPOSAL_BUSY` (409) means
another transition won; retry the same decision to check its outcome.
`AGENT_PROPOSAL_STALE` (409) means the bound notification state changed and
needs a new selection/proposal. A single-notification conditional database
conflict applies no write.
`AGENT_PROPOSAL_INDETERMINATE` (409) means the result is unknown: check the
actual notification before starting another action. Execution claims are
never reclaimed to repeat mutations after a crash or lost acknowledgement.

Proposal, approval, execution and rejection events use `audit.log` and the
new `AUDIT_ACTIONS` entries. Metadata identifies the proposal, turn, tool,
tier, exact parameters and agent origin. `audit.fromReq` supplies HTTP actor
metadata; identity stays pinned to authenticated context. Notification text
is not copied into audit metadata. Stable audit UUIDs use insert-only conflict
handling, preserving the append-only table without duplicating retry events.

Required auditing fails closed before execution. If a successful result was
saved but final auditing failed, repeating approval completes the audit and
returns the receipt without rerunning the write. Failure audit metadata
distinguishes unknown execution outcomes. If result storage fails, execution
auditing is still attempted and the API reports uncertainty. Redis and
Postgres do not share a transaction: a crash or outage can leave an unresolved
claim or missing completion audit. The mark-all service performs a bounded
exact-set update and final-state read; an outage after any mutation stays
indeterminate and the proposal executor never repeats it. Broader writes need
their own durable guarantees.

Existing notification HTTP calls and ordinary audit callers retain their
default behavior. New service options are internal and cannot be set through
model or approval input. No schema changes are required.

Unit tests cover scoped handlers, exact-set mark-all behavior, real HTTP
composition with mocked services, Redis scripts, races, stale snapshots,
audit recovery, uncertain writes,
read-only status and fresh conversation receipts. Receipt tests also cover
stale membership, corrupt/missing records, hostile history and cancellation.
`tests/integration/database/notification-proposals.test.js` covers real
membership joins, conditional updates and append-only audit deduplication;
it requires the Postgres/PostgREST/Redis test stack and has not been run here.
Live-model proposal behavior and deployed Redis recovery remain evaluation
and integration work.
