# Tier 2 proposals

The available agent writes are Tier 2 `mark_notification_read`,
`mark_all_notifications_read`, `update_my_profile`, `delete_contact`, and `update_task`.
Notification actions are scoped to the caller in the current workspace.
Task progress changes are scoped to the caller's own assignment in that workspace.
Profile and contact changes affect the authenticated user's Kith account
across all workspaces. The backend requires a proposal and a separate
approval request. Chat text and model tool calls
cannot execute any write. Other writes remain unavailable.

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

## Own task progress

After the user explicitly selects a task, send its task/container pair with
the current chat request:

```json
{
  "message": "Mark my selected task complete and add the note Done.",
  "selected_task": {
    "container_id": "<container-uuid>",
    "task_id": "<task-uuid>"
  },
  "conversation_id": null
}
```

The server rereads active membership and the task through the existing task
service. The task must be assigned to the caller, including for admins, and
its parent must belong to the authenticated workspace. Only pending,
in-progress or overdue tasks without admin confirmation are eligible.
Completed/cancelled task reopening, reassignment, admin confirmation and proof
changes are outside this Tier 2 tool.

Only a verified current-request selection offers `update_task` to the model.
Its arguments contain `status` (`in_progress` or `completed`) and optionally
`completion_note` (at most 1,000 characters, or null to clear it). An omitted
note preserves the stored note. The model cannot supply task/container IDs,
admin fields, or other task edits. A UUID in chat text, a search candidate, or
a historical selection does not select a task; ambiguous names need an explicit
choice. A no-op request is rejected without creating a card.

The card contains the resolved IDs, requested changes, reviewed task identity,
assignee, status, note and version, and exact resulting status/note. Titles and
notes remain untrusted display data; proofs, storage paths and admin notes are
excluded. Proposal creation audits and pauses the loop without updating the task.

The existing separate approval endpoint accepts `{}` and rechecks membership,
ownership and the reviewed snapshot. The task service also uses an optional
conditional update against the reviewed fields and deletion state. A changed,
reassigned, deleted or admin-confirmed task invalidates the proposal. Successful
completion keeps the existing task notification and audit flow with authenticated
actor context, plus the agent action audit stages. Repeated approval returns the
same result without repeating the update or notifications.

Task status receipts include `task_id` and `container_id`. Confirmed results
contain stored status, completion note, completion timestamp and update timestamp;
they do not imply admin confirmation. Uncertain execution remains indeterminate
and cannot be retried as a fresh execution of that proposal.

Unit tests cover handlers, scripted model turns, mocked HTTP/SSE workflows and
the real task service with a mocked database. Live Postgres concurrency and live
model behavior still require integration/evaluation coverage.

## Profile updates

`update_my_profile` is offered to every active member. Its model arguments may
contain only `full_name`, `bio`, `country_of_residence`, `timezone`,
`preferred_language`, `push_enabled`, and `email_digest_enabled`. Avatar/file
changes, identity fields, roles, email, auth settings, and unknown fields are
rejected. Server code removes fields that already have the requested value; an
all-no-op request does not create a card.

The card is bound to the exact prior values of the fields that will change.
`before.updated_at` records the profile timestamp observed when the card was
created; it is informational:

```json
{
  "id": "<proposal-uuid>",
  "tool": "update_my_profile",
  "tier": 2,
  "summary": "Update your Kith account profile: timezone.",
  "parameters": { "timezone": "Africa/Lagos" },
  "before": {
    "timezone": "UTC",
    "updated_at": "<observed-profile-timestamp>"
  },
  "after": { "timezone": "Africa/Lagos" },
  "expires_at": "<server-generated-ISO-timestamp>"
}
```

Approval rereads the reviewed fields, then conditionally updates the live
profile only while every saved prior value still matches. A change to any
reviewed field makes the proposal stale. Background `last_seen_at` updates
and edits to other fields leave the card usable; those other fields are
preserved. The execution result contains only the approved `changes` and the
newly stored `updated_at` value.

## Contact deletion

`delete_contact` is offered only when the user explicitly selects one of
their account contacts for the current chat request:

```json
{
  "message": "Delete the selected contact.",
  "selected_contact_id": "<owned-contact-uuid>"
}
```

Clients obtain the ID from the existing account contacts endpoint. The server
rereads active membership and that exact caller-owned contact before offering
the tool. Missing contacts and contacts owned by another user both return
404 before the model runs. The model's arguments must be `{}`; contact IDs
in prose, old cards and receipts never supply a selection.

The card records the complete reviewed contact state:

```json
{
  "id": "<proposal-uuid>",
  "tool": "delete_contact",
  "tier": 2,
  "summary": "Delete the selected Kith account contact.",
  "parameters": { "contact_id": "<owned-contact-uuid>" },
  "before": {
    "id": "<owned-contact-uuid>",
    "type": "whatsapp",
    "value": "+2348012345678",
    "label": "Personal",
    "country_code": "+234",
    "is_primary": false,
    "is_verified": false,
    "verified_at": null,
    "created_at": "<stored-contact-ISO-timestamp>"
  },
  "after": { "deleted": true },
  "expires_at": "<server-generated-ISO-timestamp>"
}
```

Contact values and labels are untrusted display data. The account owner ID
is excluded from the card and bootstrap selection. Approval rereads every
reviewed field, then the existing contact service conditionally deletes only
the row whose ID, owner and complete saved state still match. Changed values,
labels, primary flags or verification state invalidate the card. A conditional
conflict deletes nothing. Missing rows invalidate the card and return 404.
The execution result is `{ "contact_id": "<owned-contact-uuid>", "deleted": true }`.
It describes the approved deletion, not a fresh lookup of account contacts.

The tool removes one account contact. Contact saving through `upsert_contact`
remains pending: its existing RPC can change primary flags on other contacts
and does not check saved approval state. That behavior needs its own guarded
design before the tool is exposed.

## Approve or reject

Send a distinct authenticated POST with an empty JSON body `{}` to:

```text
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/approve
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/reject
```

Both routes share the agent's per-user request limiter and never call the
model. They reject parameter, identity, tier and tool overrides. Approval uses
the saved parameters, rereads membership, audits the approval, verifies the
bound state and calls the matching existing domain service. For one
notification, changes to the reviewed title/type/date/read state invalidate
the proposal and the conditional update cannot rewrite an existing read
timestamp. For mark-all,
every saved ID must still exist, belong to the same recipient/workspace and be
unread before execution. The update filters on only those IDs and then verifies
that every target is read. A target concurrently read elsewhere is already in
the desired final state; a later notification is never included.

Approval returns `{ data: { proposal_id, status: "executed", result } }`.
The single-notification result contains `notification_id`, `is_read: true` and
the database's stored `read_at`. The mark-all result contains the bound
`notification_count` and the actual `updated_count`; the latter can be smaller
when another request read a bound notification during execution. For
`update_my_profile`, the result contains the exact approved `changes` and the
stored `updated_at` timestamp.
For `delete_contact`, the result contains only `contact_id` and `deleted: true`.
Rejection returns `{ data: { proposal_id, status: "rejected" } }`.
Repeated successful decisions return the saved receipt; an opposite decision
returns a conflict. Display the decision beside its proposal. Approval does
not call the model or append a conversation turn. Later conversation turns
refresh saved action receipts as described below; current domain facts still
require fresh reads. Saying “approve” in chat cannot execute it.
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

For `update_my_profile`, the status response uses `profile_fields` (the names
of the fields in the proposal) instead of a notification target. An executed
result contains the exact approved values and the stored timestamp, for example:

```json
{
  "changes": { "timezone": "Africa/Lagos" },
  "updated_at": "<stored-profile-timestamp>"
}
```

For `delete_contact`, the status response uses `contact_id` as its target.
An executed result is `{ "contact_id": "<owned-contact-uuid>", "deleted": true }`.

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
past action; it does not reread the affected notification, profile or contact.

When a conversation resumes, server code finds proposal cards only in validated,
correlated calls/results for the supported proposal tools in retained history.
It ignores IDs in user/assistant prose, other tool payloads and old receipt
arrays. The server rechecks membership and compares each complete historical
card with its scoped Redis record, then adds fresh `action_receipts` to this
turn's initial `get_my_context` result, inside the untrusted-data envelope.
This does not offer another model-callable tool or restore notification or
contact selection.

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
`AGENT_PROPOSAL_STALE` (409) means the reviewed notification/contact state or
profile fields changed and need a new proposal. Proposals for a selected
notification or contact also need a fresh selection. A conditional database
conflict applies no write.
`AGENT_PROPOSAL_INDETERMINATE` (409) means the result is unknown: check the
affected notification, profile or contact before starting another action.
Execution claims are never reclaimed to repeat mutations after a crash or lost
acknowledgement.

Proposal, approval, execution and rejection events use `audit.log` and the
new `AUDIT_ACTIONS` entries. Metadata identifies the proposal, turn, tool,
tier, exact parameters and agent origin. `audit.fromReq` supplies HTTP actor
metadata; identity stays pinned to authenticated context. Notification text,
contact values and contact labels are excluded from audit metadata. Stable
audit UUIDs use insert-only conflict handling, preserving the append-only
table without duplicating retry events.

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

Existing notification, profile and contact HTTP calls and ordinary audit
callers retain their default behavior. New service options are internal and cannot be set
through model or approval input. No schema changes are required.

Unit tests cover scoped handlers, exact-set mark-all behavior, real HTTP
composition with mocked services, Redis scripts, races, stale snapshots,
conditional profile updates and contact deletion, audit recovery, uncertain
writes, read-only status and fresh conversation receipts. Receipt tests also cover
stale membership, corrupt/missing records, hostile history and cancellation.
`tests/integration/database/notification-proposals.test.js` covers real
membership joins, conditional updates and append-only audit deduplication;
it requires the Postgres/PostgREST/Redis test stack and has not been run here.
Profile field comparisons, soft-deleted user filtering and concurrent updates
still need verification against that real stack; unit mocks do not prove
database atomicity.
Contact deletion tests cover ownership, complete snapshot comparisons, model
target overrides and JSON/SSE receipts without restored selection. Real
database/PostgREST coverage of the conditional contact delete remains pending.
Live-model proposal behavior and deployed Redis recovery remain evaluation
and integration work.
