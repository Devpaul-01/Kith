# Notification proposals

The first agent write is Tier 2 `mark_notification_read`: one notification
belonging to the caller in the current workspace. The backend requires target
selection, a proposal, and a separate approval request. Chat text and model
tool calls cannot execute the write. Other writes remain unavailable.

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

When requested by the model, the server rereads the notification, persists
and audits a proposal, then ends the turn. A proposal tool call must appear
alone, not in a batch of reads or proposals. Chat can also return a normal
text reply without proposing anything.

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

## Approve or reject

Send a distinct authenticated POST with an empty JSON body `{}` to:

```text
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/approve
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/reject
```

Both routes share the agent's per-user request limiter and never call the
model. They reject parameter, identity, tier and tool overrides. Approval uses
the saved parameters, rereads membership, audits the approval, verifies the
preview and performs a conditional domain-service update. Changes to the
reviewed title/type/date/read state invalidate the proposal. Concurrent
updates cannot rewrite an existing read timestamp through this path.

Approval returns `{ data: { proposal_id, status: "executed", result } }`.
The result contains `notification_id`, `is_read: true` and the database's
stored `read_at`. Rejection returns `{ data: { proposal_id, status: "rejected" } }`.
Repeated successful decisions return the saved receipt; an opposite decision
returns a conflict. Display the decision beside its proposal. Approval does
not call the model or append a conversation turn; later chat must refresh
notification facts through reads. Saying “approve” in chat cannot execute it.
Disconnecting after submitting approval does not revoke it; retry the same
proposal ID to learn its outcome rather than creating a replacement action.

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
`AGENT_PROPOSAL_STALE` (409) means the notification changed and needs a new
selection/proposal. A conditional database conflict applies no write.
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
claim or missing completion audit. This first path relies on a conditional
notification update; broader writes need their own durable guarantees.

Existing notification HTTP calls and ordinary audit callers retain their
default behavior. New service options are internal and cannot be set through
model or approval input. No schema changes are required.

Unit tests cover scoped handlers, real HTTP composition with mocked services,
Redis scripts, races, stale snapshots, audit recovery and uncertain writes.
`tests/integration/database/notification-proposals.test.js` covers real
membership joins, conditional updates and append-only audit deduplication;
it requires the Postgres/PostgREST/Redis test stack and has not been run here.
Live-model proposal behavior and deployed Redis recovery remain evaluation
and integration work.
