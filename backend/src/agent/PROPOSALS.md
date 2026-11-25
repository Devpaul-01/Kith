# Agent action proposals

The available agent writes are Tier 2 `mark_notification_read`,
`mark_all_notifications_read`, `update_my_profile`, `delete_contact`, `update_task`,
and `create_ledger_entry` for a self contribution.
Admins can also request Tier 3 `confirm_ledger_entry` for an explicitly selected
eligible contribution, with a full before/after approval card.
An admin's explicit `selected_task_confirmation` enables Tier 3
`admin_confirm_task` for a completed, unconfirmed task, including uploaded proofs.
Tier 3 `create_container` creates a new event through a full approval card and
requires no existing entity selection.
Tier 3 `create_member` creates an ordinary member record or a proxy managed by
the requesting admin, also through a full card without an existing selection.
An admin's explicit `selected_participant_addition` member/event pair enables
Tier 3 `add_participants` for one eligible non-proxy workspace member.
An admin's explicit `selected_task_creation` container and optional assignee
enables Tier 3 `create_task` for one new pending task.
The caller's explicit `selected_dispute_entry` enables Tier 4 `raise_dispute`
for their own confirmed base-currency contribution, through a full card,
separate approval and a distinct typed confirmation request.
An admin's explicit `selected_dispute_resolution` enables Tier 4
`resolve_dispute` for one eligible owner-raised dispute, using the same
separate approval and typed-confirmation controls.
Notification actions are scoped to the caller in the current workspace.
Task progress changes are scoped to the caller's own assignment in that workspace.
Self contributions are scoped to their own money-enabled participation in an
active event container and always remain pending for admin review.
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

## Event container creation

An admin requests a new event through the existing chat input:

```json
{
  "message": "Create an event called Family groceries on 2026-12-01 with money and task tracking.",
  "conversation_id": null
}
```

`create_container` is offered to admins without an entity selection. Only a
requested draft reads fresh workspace/admin state and pins it in the card.
Its strict model arguments are `name` plus optional `subtitle`, `description`,
`event_date`, `event_type`, `event_type_category`, `enable_money` and
`enable_tasks`. Names use the existing 2–100 character limit; subtitle,
description and event type limits are 200, 2,000 and 80 characters. Text is
trimmed, and omitted/empty optional text becomes null. NUL and unpaired Unicode
surrogates are rejected before database access; valid emoji pairs are allowed.
Dates must be explicit valid `YYYY-MM-DD` calendar dates. Relative or ambiguous
dates require clarification. Tracking flags default to false and category to
`other`; only requested values should be supplied.

This milestone creates active event containers. Budgets, recurring schedules,
participants, assets/uploads and public links are excluded. The model cannot
supply a workspace, creator, ID, state, execution time or inert-default fields.
The server allocates the new container UUID from the proposal UUID. Separate
approved cards create separate containers, including when names are identical.

The full Tier 3 `before` card includes the reviewed workspace identity/name/
version, real admin and `container: null`. The `after` projection contains the
new ID, creator, requested fields and every fixed stored business field:
active event state, null recurrence/budget/link/conversion/completion/deletion
values and empty cover/outcome assets. Existing SQL defaults
`auto_generate_cycles: true` and `public_show_names: true` are preserved; an
event schedules no recurring jobs and its null public token exposes no link.
`created_at` and `updated_at` are previewed as `on_approval`; execution generates
the same actual instant for both and verified receipts carry the stored ISO
values. Names and descriptions remain untrusted display data.

The draft checks the complete eventual executed record against the existing
16 KiB storage limit before issuing the card, including the result copy,
bounded timestamps and bookkeeping. Text that fits individual character limits
can still exceed that encoded record limit; shorten metadata when rejected.
This check prevents a predictable receipt-storage failure after creation.

Approval uses the existing separate endpoint with a strict empty `{}` body.
The domain explicitly checks admin access and revalidates the workspace. The
opt-in `createContainer` service path rereads actual active non-proxy admin
membership and the non-deleted workspace, then inserts the server-owned ID,
exact reviewed values, inert defaults and execution timestamps. It verifies
the complete returned business state and time before required native auditing.
The ordinary HTTP creation path and recurring job behavior remain unchanged.

The existing Redis execution claim deduplicates approval; the containers primary
key also prevents repeated insertion of the same generated ID. INSERT errors,
PK collisions, transport uncertainty, malformed results and post-insert audit
failure retain the irreversible claim. There is no native replay or repair path.
Saved successful results can finish final agent auditing without another INSERT.
Every audit and status targets the preallocated container ID, even before the
new row exists or when result persistence is uncertain. Tier 3 agent metadata
includes the full reviewed before/after state. Role-scoped records and history
prevent member turns from restoring admin creation calls.

Fresh admin/workspace reads remain separate from INSERT. Stronger concurrent
eligibility protection requires a service/database decision and live Postgres
coverage. Unit checks cover explicit permission denial, normalized/fixed state,
Unicode and size boundaries, strict args/approval, stale context, uncertain
outcomes, duplicate approvals, receipts, scripted turns and mocked HTTP/SSE.
Live database concurrency and live model evaluation remain unverified.

## Member creation

An admin can request a new member through the existing chat endpoint:

```json
{
  "message": "Create a proxy member named Chika Okafor, managed by me, with relationship cousin.",
  "conversation_id": null
}
```

`create_member` accepts only `display_name` and optional `is_proxy`,
`relationship_to_head`, `relationship_category`, `date_of_birth` and
`admin_notes`. Names are trimmed and use the existing 2–80 character limit;
relationship text and notes are limited to 100 and 1,000 characters. Optional
text is trimmed, with omitted or empty text stored as null. NUL and unpaired
Unicode surrogates are rejected; valid emoji pairs are supported. Birth dates
must be explicit valid `YYYY-MM-DD` calendar dates. The model must clarify
unclear requests and cannot calculate a birth date from an age.

The default is an ordinary member (`is_proxy: false`); a proxy requires explicit
proxy intent. Its manager is the requesting admin. Selecting another manager
is not supported in this milestone. Category defaults to `other`, and the
optional birth date defaults to null. The server fixes `role: member`,
`user_id: null`, active status, invitation/activity fields and contribution
counters. Creating this record does not create or link a login, send an
invitation, add participants or upload files. Requests to invite an existing
user or alter an existing member need clarification rather than silently
creating a duplicate. Separate approved creation cards create separate records,
including when display names match.

The Tier 3 card's `before` shows the freshly read workspace identity/name/version,
the current admin and `member: null`. Its `after` shows the complete new member
state, including the server-owned member UUID (the proposal UUID), proxy manager
and all fixed fields. `joined_at`, `created_at` and `updated_at` are
`on_approval`; successful receipts contain their actual stored timestamps.
Names, relationship text and admin notes remain untrusted display data.
Draft creation verifies that the complete eventual executed record fits the
existing 16 KiB storage limit, including the result copy and bookkeeping.

Approval uses the existing separate endpoint with strict empty `{}` input.
The handler rechecks admin access and reviewed context. The opt-in
`member.service.js#createMember` path then rereads the live, active, non-proxy,
non-deleted admin membership and non-deleted workspace before inserting the
exact reviewed state. It verifies every returned business field and all three
timestamps. The ordinary member HTTP creation path keeps its existing behavior.

The normal `member.created` audit is required. A proxy also receives a
`proxy_actions` record with that action enum, its member ID, authenticated
manager and agent/proposal metadata. The existing agent proposed/approved/
executed/rejected audits target the preallocated member UUID and retain the
full reviewed before/after state. Status and conversation receipts use
`member_id` and return the verified new-member state after successful execution.
They report that past creation and never grant account access or select a
target for another write.

The Redis execution claim prevents repeated approval from inserting twice;
the member primary key also prevents another insert using the same proposal ID.
Insert uncertainty, returned-state mismatches and failures in either native
audit retain an indeterminate claim. The executor never repeats that insertion.
A saved successful result can finish final agent auditing without another write.

Fresh eligibility checks, member insertion and auditing are separate operations.
Concurrent revocation or a crash between these operations can leave an applied
member with an uncertain receipt or incomplete audit. Stronger transactional
guarantees need a separate database design decision. Unit tests cover permission
and field boundaries, ordinary/proxy cards, stale and duplicate approvals,
uncertain outcomes, receipts, scripted clarification and mocked JSON/SSE flows.
Live PostgreSQL/Redis concurrency and model behavior remain integration and
evaluation work. No schema changes or dependencies are required.

## Participant additions

An admin explicitly selects one existing workspace member and one event for
the current chat request:

```json
{
  "message": "Add the selected member to the selected event with money tracking.",
  "selected_participant_addition": {
    "container_id": "<container-uuid>",
    "member_id": "<workspace-member-uuid>"
  },
  "conversation_id": null
}
```

Only this verified current pair offers `add_participants`. The member must be
active, non-deleted and non-proxy in this workspace; either a member or admin
membership is eligible, including a record without a linked login. The
container must be an active, non-deleted event in the same workspace. Existing
participation is rejected. Names, search candidates, UUIDs in prose, old
selections and receipts do not select either target. Ambiguous names require
the user to choose the member and event before requesting the card.

Strict model arguments contain only optional `money_enabled` and
`tasks_enabled`. Both default to false; a requested true flag requires the
corresponding event feature to be enabled. No targets, amounts, participant
notes, custom participation roles, group/bulk additions, proxies or recurring
pools are supported. Participation does not change the workspace member role,
create an account or send an invitation. Recurring additions need a separate
design because existing cycle overrides can generate contribution targets.

The full Tier 3 `before` card contains workspace identity/name/version, the
authenticated admin, event name/type/status/features/version, selected member
name/role/eligibility/version and `participant: null`. Text remains untrusted
display data. The complete `after` projection is:

```json
{
  "participant_id": "<proposal-uuid>",
  "container_id": "<container-uuid>",
  "workspace_member_id": "<workspace-member-uuid>",
  "money_enabled": true,
  "tasks_enabled": false,
  "role": null,
  "notes": null,
  "exclude_from_public": false,
  "added_by": "<authenticated-admin-member-uuid>",
  "added_at": "on_approval"
}
```

The proposal UUID fixes the new participation UUID. `added_at` is generated
on approval; verified receipts contain its stored ISO timestamp and every
field shown above. Status and conversation receipts identify `participant_id`,
`container_id` and `workspace_member_id` and report the past action. They never
restore a selection or authorize another write. The draft checks the complete
eventual executed record against the existing 16 KiB storage limit.

Approval uses the existing separate endpoint with strict empty `{}` input.
The handler explicitly checks admin access and revalidates the full selection.
The opt-in `participant.service.js#addParticipants` branch rereads the live,
active non-proxy admin and exact user link, workspace, member, event and absent
participation before inserting the reviewed state. Names or versions changing,
lost eligibility or a member added elsewhere invalidate the card. The ordinary
participant HTTP path keeps its existing behavior.

The Redis execution claim prevents repeated approval from inserting again.
The existing unique member/container pair uses duplicate-ignore upsert,
preserving any existing participant. Only an explicit successful empty result
proves that insertion made no change and produces a stale proposal. Database
errors, transport uncertainty, malformed or mismatched returned state and
post-insert required audit failures retain an indeterminate claim. This
proposal never retries the insertion. Saved successful results can complete
final agent auditing without another participant write.

The native `container.participants_added` audit is required. Agent
proposed/approved/executed/rejected audits target the event and include the
full reviewed before/after state. Fresh related-row checks, insertion and
auditing are separate operations; concurrency and partial failures across
them still require live Postgres/Redis integration coverage and a broader
transactional design decision. Unit tests cover role/scope/eligibility,
complete defaults, stale and duplicate approvals, uncertain outcomes,
receipt binding, scripted turns and mocked JSON/SSE flows.

## Task creation

An admin selects a container and, optionally, one assignee for the current
authenticated chat request:

```json
{
  "message": "Create Buy groceries for the selected member, due 2026-12-01.",
  "selected_task_creation": {
    "container_id": "<container-uuid>",
    "assignee_id": "<workspace-member-uuid>"
  },
  "conversation_id": null
}
```

Omitting `assignee_id` or passing null creates an unassigned task. Only this
verified current selection offers `create_task`. The container must be an
active, non-deleted, task-enabled event or recurring container in the current
workspace. An assignee must be an active, non-deleted, non-proxy member/admin
of that workspace with existing `tasks_enabled` participation in the
container. A member record without a linked login is eligible. Search
candidates, UUIDs in prose, other task/ledger selections, old selections and
receipts cannot supply either ID. Ambiguous names or a requested assignee
that is not selected require clarification and a current selection.

Strict model arguments contain `title`, optional `description` and optional
`due_date`. Titles are trimmed to 1–200 characters; descriptions are trimmed
to at most 2,000 characters, with omitted or empty descriptions becoming
null. NUL and unpaired surrogates are rejected. Dates must be valid explicit
`YYYY-MM-DD` calendar dates or null; omitted dates become null and explicit
past dates are allowed. Relative or ambiguous dates require clarification.
Proxies, bulk creation, proof uploads, custom sorting and status/admin
overrides are outside this tool's scope. Each separately approved card
represents one new task.

The full Tier 3 `before` card contains workspace identity/name/version,
authenticated admin, container name/type/status/task setting/version,
optional assignee name/role/eligibility/member version and participation
ID/creation time, plus `task: null`. Names and task text remain untrusted
display data. The complete `after` projection is:

```json
{
  "task_id": "<proposal-uuid>",
  "container_id": "<container-uuid>",
  "title": "Buy groceries",
  "description": null,
  "assigned_to": "<workspace-member-uuid>",
  "due_date": "2026-12-01",
  "status": "pending",
  "completed_at": null,
  "completed_by": null,
  "completion_note": null,
  "proofs": [],
  "sort_order": 0,
  "created_by": "<authenticated-admin-member-uuid>",
  "deleted_at": null,
  "admin_confirmed_at": null,
  "admin_confirmed_by": null,
  "admin_note": null,
  "created_at": "on_approval",
  "updated_at": "on_approval"
}
```

The proposal UUID fixes the new task UUID. Both timestamps are generated
together on approval; successful results verify every field and both stored
timestamps. The draft checks the eventual executed record against the
existing 16 KiB limit. Status and conversation receipts bind `task_id` to
`proposal_id`, and identify `container_id` and nullable `assigned_to`, even
before execution. Verified results carry the full creation state. Receipts
describe the past creation; later overdue processing or edits can change the
task's current state. They never restore selection or authorize another write.

The five-minute card uses the existing separate approval endpoint with strict
empty `{}` input. Handlers explicitly check admin access. Approval revalidates
the full reviewed context; the opt-in `task.service.js#createTask` branch
rereads the active non-proxy admin and exact user link, workspace, container,
optional member and participation immediately before INSERT. Changed names
or versions, replacement participation, lost eligibility or revoked admin
access invalidate the reviewed creation before insertion.

The fixed primary key and Redis execution claim prevent repeated approval
from creating another task. INSERT errors, including primary-key conflicts,
transport uncertainty, malformed/mismatched stored state and required native
audit failures retain an indeterminate claim. Approval never retries that
insertion. Saved successful results can finish final agent auditing without
another task write.

The native `task.created` audit is required before assignment notification.
It records the title, agent origin and proposal ID. Agent
proposed/approved/executed/rejected audits target the new task and include the
full reviewed before/after state. Assigned tasks use the existing notification
sender with dedup key `task_assigned:<task-id>`; notification failures are
logged and do not invalidate a verified, audited creation. Unassigned tasks
have no assignment notification.

Fresh related-row checks, INSERT and auditing are separate operations. Live
Postgres/Redis integration coverage is still needed for concurrent eligibility
changes and partial failures across those operations; stronger transactional
guarantees need a separate design decision. Unit coverage includes explicit
role checks, assigned/unassigned defaults, stale/duplicate approvals,
uncertain outcomes, bound records/receipts, scripted turns and mocked JSON/SSE
flows. This milestone requires no schema changes or new dependencies.

## Dispute creation and secondary confirmation

Members and admins explicitly select their own confirmed contribution for
the current authenticated chat request:

```json
{
  "message": "Dispute this contribution because the recorded amount does not match my payment.",
  "selected_dispute_entry": {
    "container_id": "<event-container-uuid>",
    "entry_id": "<own-confirmed-entry-uuid>"
  },
  "conversation_id": null
}
```

Only this verified current selection offers `raise_dispute`. The caller must
have active, linked, non-proxy membership in the current workspace. Ownership
is required even for admins. The contribution must be confirmed, positive,
non-crypto and in the workspace base currency, with equal original/base
amounts and no recurring cycle or correction link. Its event must be active,
non-deleted and money-enabled. No open dispute may already exist. Current
container participation is not required to dispute a historical contribution.
Pending entries, expenses, recurring pools, proxies, bulk/on-behalf actions
and dispute resolution are outside this tool's scope.

Strict model arguments contain only the requested `reason`, trimmed to
5–1,000 characters. NUL and unpaired surrogates are rejected. Missing or
ambiguous reasons require clarification. Names, IDs in prose, searches,
other selections, previous cards, receipts and messages saying “confirm”
cannot supply the selection or either decision.

Existing uploaded proofs do not prevent raising a dispute. Proof metadata
and private idempotency keys are excluded from this approval projection;
the tool never uploads, inspects or claims to preserve attachment contents.
The existing ledger immutability trigger freezes confirmed financial fields
while allowing proofs to change. Restricting this tool to confirmed entries
and excluding mutable proofs allows the existing RPC to remain in use
without a schema change. Nullable legacy recording/confirmation fields are
preserved exactly.

The full Tier 4 `before` contains workspace identity/name/currency/version,
authenticated caller identity/name/role/version, event identity/name/type/
status/money setting/version, all reviewed immutable entry fields and
`dispute: null`. The `after` contains that same entry with `status: disputed`
and the complete new dispute state:

```json
{
  "dispute_id": "on_confirmation",
  "workspace_id": "<workspace-uuid>",
  "ledger_entry_id": "<selected-entry-uuid>",
  "raised_by": "<authenticated-caller-member-uuid>",
  "reason": "The recorded amount does not match my payment.",
  "status": "open",
  "resolution_note": null,
  "resolved_by": null,
  "raised_at": "on_confirmation",
  "resolved_at": null,
  "notes": []
}
```

The card also carries `secondary_confirmation: { method: "typed", phrase:
"confirm" }`. Postgres generates the actual dispute UUID and timestamp
inside `raise_dispute_atomic`; the dispute UUID is independent of the
proposal UUID. The eventual executed record is checked against the existing
16 KiB limit before the card is stored or audited. Names, notes and the
reason remain untrusted display data.

First send the normal authenticated approval request with strict empty `{}`
input:

```text
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/approve
```

It audits approval and revalidates the reviewed context. It opens no dispute
and returns:

```json
{
  "data": {
    "proposal_id": "<proposal-uuid>",
    "status": "awaiting_confirmation",
    "confirmation_token": "<server-generated-uuid>",
    "expires_at": "<original-card-expiry>"
  }
}
```

After the user explicitly types `confirm`, send a separate authenticated
request to:

```text
POST /v1/workspaces/:workspaceId/agent/proposals/:proposalId/confirm
```

Its strict body is:

```json
{
  "confirmation": "confirm",
  "confirmation_token": "<token-from-approval-response>"
}
```

The literal is case-sensitive. The token is scoped through the saved
user/member/workspace/role record and must match that exact proposal.
Approval retries return the same token without extending the original
five-minute deadline. A known token cannot replace approval; confirming a
pending/approving card returns `AGENT_PROPOSAL_CONFIRMATION_REQUIRED` (409).
A wrong valid token returns `FORBIDDEN` (403); invalid bodies return 400.
The confirm endpoint rejects Tier 2/3 cards and never calls the model.
Both decision endpoints share the existing agent request limiter and return
`Cache-Control: no-store` on success.

The confirmation token is server-record bookkeeping. It is returned only
by explicit approval and is never added to proposal cards, stored chat
history, provider context, status/conversation receipts or audit metadata.
An approved card can still be rejected while awaiting confirmation; CAS
settles reject/confirm races. Once confirmation is processing, use the same
confirmation request to retry. Approval cannot bypass that step.

Typed confirmation first requires the stable, dedicated
`agent.action_confirmed` audit, then rechecks fresh membership, ownership,
all reviewed context and expiry before acquiring the irreversible execution
claim. The native reviewed branch rechecks the real caller and exact user
link again before invoking the existing RPC. It verifies the complete new
dispute, requires `dispute.raised` auditing, then rereads the selected entry
and verifies the immutable financial fields with disputed status. Admin
notifications use the existing sender with dedup key
`contribution_disputed:<dispute-id>`; notification failures are logged
separately and do not invalidate a verified, audited result.

Sensitive agent audits include the full before/after projection, sensitivity
and secondary-confirmation tags, the server turn UUID as `session_id` and
the actual scoped conversation UUID as `conversation_id`. Stateless turns
use null for the latter. Native auditing receives that same stored trace.
Stable audit IDs make approval/confirmation/final-audit retries idempotent.

The RPC atomically inserts the dispute and changes the ledger status, with
row locking and the existing unique open-dispute index. Only explicit null-
data PostgreSQL rejections for known eligibility/uniqueness failures prove
that no mutation occurred and become stale proposals. RPC transport,
malformed result, post-read and required native audit uncertainty retain the
execution claim; the mutation is never replayed. Pre-execution malformed or
unavailable reads remain retryable. Saved results can finish final agent
auditing through approve or confirm without another RPC.

Status and conversation receipts use the selected `entry_id` and
`container_id`; successful results contain the actual dispute ID and full
verified dispute/entry projection. `awaiting_confirmation` and
`confirmation_pending` are result-free and do not confirm execution. A
receipt describes the past opening; later dispute resolution can change
current state. Fresh actor/container checks, RPC, auditing, Redis storage
and post-read are separate operations. Live Postgres/PostgREST/Redis coverage
is still needed for text casts, deployed immutability, concurrent eligibility
changes and partial failures across them.

## Admin dispute resolution

An admin explicitly selects an open dispute for the current authenticated
chat request:

```json
{
  "message": "Resolve this dispute. The payment was checked and the recorded contribution is correct.",
  "selected_dispute_resolution": {
    "dispute_id": "<dispute-uuid>"
  },
  "conversation_id": null
}
```

Only this current verified selection offers `resolve_dispute`. The caller
must have active, linked, non-proxy admin membership. The dispute must be
open, have null resolution fields, and be raised by the same active non-proxy
member who owns its contribution. An owner without a currently linked login
is supported. Current container participation is not required.

The contribution must currently be disputed, positive, non-crypto and in the
workspace base currency, with equal original/base amounts, no recurring cycle
or correction link, and recorded `confirmed_by`/`confirmed_at`. Its event must
be active, non-deleted and money-enabled. The confirmation-field requirement
conservatively narrows this milestone; it does not reconstruct legacy history.
Entries missing those fields remain outside resolution scope even when they
were eligible for the separate dispute-creation tool. Recurring pools,
expenses, proxies, disputes raised on behalf of another member, bulk closure
and financial corrections are outside this tool's scope.

Strict model arguments contain only `resolution_note`, trimmed to 10–1,000
characters, with NUL and unpaired surrogates rejected. Missing or ambiguous
notes require clarification. The server binds `dispute_id`, `entry_id` and
`container_id` from the current selection; IDs in prose, searches, other
selections, prior cards and receipts cannot choose or approve this action.

The full Tier 4 `before` includes workspace/admin/event names and versions,
the contribution owner's name/role/version, all immutable reviewed entry
fields, and the existing dispute identity, reason, raiser and timestamp.
The `after` preserves those entry fields and existing dispute details, with
these exact closing changes:

| Field | Before | After |
|---|---|---|
| Dispute status | `open` | `resolved` |
| Entry status | `disputed` | `resolved` |
| Resolution note | `null` | Exact requested, trimmed note |
| Resolver | `null` | Authenticated admin member ID |
| Resolution time | `null` | `on_confirmation` until execution |

The existing ledger treats a resolved contribution as paid. Resolution
preserves amounts and original recording/confirmation metadata; it does not
create a correction or alter financial values. Summaries still come from
tools, without model arithmetic. Uploaded proofs and appended dispute notes
are eligible but excluded from the review/result projection, along with
private idempotency keys. The tool never uploads, inspects or freezes those
mutable contents. Existing services update dispute closing fields and notes
separately; the unchanged RPC preserves the notes column.

Use the [same two-step approval and typed-confirmation API](#dispute-creation-and-secondary-confirmation).
The full card carries `secondary_confirmation: { method: "typed", phrase:
"confirm" }`. Empty `{}` approval audits and revalidates, then returns the
private token with the original expiry. A separate strict confirm request
records the required secondary audit and checks fresh state before claiming
execution. Chat text cannot perform either decision. Tokens never enter
cards, provider context, history, status receipts or audits.

The reviewed native branch independently verifies the authenticated admin,
owner and scoped context, then calls `resolve_dispute_reviewed_atomic`. Inside
the transaction, that RPC locks the workspace, ordered actor/owner members,
event, ledger entry and dispute; it rechecks eligibility and the complete
approved snapshots. Both conditional updates must affect exactly one row or
the transaction rolls back. It returns both whitelisted projections, not a
later post-read. Verify all returned stable fields and the exact server-generated
resolution instant before requiring `dispute.resolved` auditing with the saved
session/conversation trace. The stored timestamp is retained verbatim.
Best-effort raiser notifications use `dispute_resolved:<dispute-id>` deduplication.

Only null-data PostgreSQL `P0001` with exact `REVIEWED_DISPUTE_STALE` proves a
reviewed no-write rejection and becomes a stale card. Transport/malformed-result
and required native-audit uncertainty retain the irreversible claim. Saved
results can finish final agent auditing through approve or confirm without
another RPC. Status and continuation receipts bind the same dispute, entry
and container IDs; successful results require both resolved states and preserve
all reviewed financial fields. Pending confirmation receipts certify no write.

Required native auditing, Redis storage and final auditing remain separate
from the mutation transaction; no durable automatic replay is introduced.
Ordinary HTTP resolution retains its signature and dispute-only result but
now locks entry before dispute and requires both transitions. This matches the
ordinary raise RPC's lock order. Both resolvers have pinned search paths and
service-role-only execution grants; independent handler authorization remains
mandatory. Target database deployment and ACL inspection are still pending.

#### Integration coverage and deployment status

`tests/integration/database/dispute-proposals.test.js` adds 12 cases through
real domain/proposal services, Postgres/PostgREST and Redis (no paid model
calls). Supported-flow assertions cover both Tier 4 gates, stored financial
projections, exact reason/resolution note and timestamps, owner/admin scope,
receipts, duplicate decisions, native/lifecycle audit deduplication and
notification records. Fault-injection cases exercise a required secondary
audit outage before mutation, final audit recovery from a saved result, and
native-audit/lost-RPC-response uncertainty after real committed mutations.
Ordinary service callers retain their dispute-only result shape.

**Execution status:** the dispute integration suites (`dispute-proposals`,
`dispute-resolution-atomic` and `dispute.routes`) passed locally, 44 tests, against
Postgres 16 with `migrations/001_schema.sql`, PostgREST v12.0.2 and Redis. That
is not a CI run and does not certify a target database or its real Supabase
roles. The separate `dispute-resolution-atomic.test.js` suite adds ordinary/reviewed resolver races,
competing eligibility edits, mandatory row-count rollback regressions and
rollback-only role/ACL fixtures. Unsafe partial outcomes are not accepted.

See [the core checklist](CORE_COVERAGE.md) for verification status and the
[approved reviewed-resolution SQL patch](DISPUTE_EXECUTION_SCHEMA_PROPOSAL.md)
for targeted deployment instructions. It is implemented in source and wired
into the reviewed service branch, **not deployed** to any existing database.
Reviewed raise hardening is a separate **proposed, unapproved** patch: see
[the raise SQL proposal](DISPUTE_RAISE_SCHEMA_PROPOSAL.md). It is not in the
schema and the raise service still uses the ordinary RPC.

## Admin ledger confirmation

An admin explicitly selects an entry for the current chat request:

```json
{
  "message": "Confirm the selected contribution.",
  "selected_ledger_entry": {
    "container_id": "<container-uuid>",
    "entry_id": "<entry-uuid>"
  },
  "conversation_id": null
}
```

The backend validates the pair and fresh admin membership before offering
`confirm_ledger_entry`. Historical confirmation tool calls are also restricted
to admin turns. Its model arguments are strictly `{}`. IDs, amounts,
contributor/confirmer, timestamps and force cannot come from model arguments.
Names, search candidates, IDs in prose, previous cards and receipts do not
select an entry. Ambiguous results require the user to choose a target.

This milestone supports pending, proof-free, non-crypto contributions in the
workspace's freshly read base currency, with identical original/base amounts,
in active event containers. The contributor must have active, non-deleted,
non-proxy membership and money-enabled participation. Recurring cycles,
expenses, corrections, disputes, proof-uploaded entries, foreign currency,
proxies and force overrides remain outside this tool.

The Tier 3 `before` card includes the complete pending entry business snapshot,
contributor label, container/version, currency and reviewed eligibility. The
`after` snapshot fixes the same IDs, recorded identity/time, exact decimal
amounts, currency, note, payment method and empty proofs, changing only
`status: confirmed`, `confirmed_by` to the authenticated admin and
`confirmed_at: on_approval`. That timestamp is a plan: the service generates
the actual confirmation time during execution and returns the stored ISO value
in the receipt. Proposal creation never confirms an entry. Names and notes
remain untrusted display data.

Approval uses the existing separate endpoint and a strict empty `{}` body.
The domain explicitly checks admin access before calling ledger services and
rereads the full reviewed context. The opt-in ledger service path performs its
own fresh admin/eligibility checks, then conditionally updates only the exact
reviewed pending entry. Predicates cover every reviewed ledger business field,
workspace/container identity, nullable fields and empty proofs. A changed
amount, note, contributor, state or proof invalidates the approval. An explicit
zero-row update with no database error proves no mutation; query/transport or
returned-data uncertainty and failures after the update retain the irreversible
execution claim and never authorize a repeat.

One approved card executes once through the existing Redis state machine.
Successful confirmation preserves contributor notifications and the existing
ledger-confirmed audit. Every agent audit targets the known ledger entry;
Tier 3 metadata includes the reviewed before/after state. Verified receipts
contain the complete confirmed entry projection and actual confirmation time,
without internal keys or extra storage data. Record and receipt validation
binds every returned field to the approved card. Retries can finish final agent
auditing from a saved result without confirming or notifying again.

The entry predicates guard the row being confirmed. Related workspace,
membership, container and participation reads are separate from the update,
and existing HTTP writers retain their previous behavior. Global concurrent
writer/eligibility protection needs a broader service or database/RPC decision
and live Postgres integration coverage. Read-only turns retain the existing
membership-cache policy: application changes invalidate immediately, while
external edits or missed invalidation can retain a cached role for up to
30 seconds. Confirmation selection/drafts, approval, execution and actual
saved-receipt lookups reread membership. Unit coverage includes explicit role
denials, exact snapshots/CAS predicates, stale state, duplicate/concurrent
approvals, uncertain outcomes, scripted model turns and mocked HTTP/SSE flows.
Live database concurrency and live model behavior remain unverified.

## Self contributions

After the user explicitly selects an eligible container, send its ID with the
current chat request:

```json
{
  "message": "Submit my NGN 5,000 contribution to the selected container by bank transfer.",
  "selected_container_id": "<container-uuid>",
  "conversation_id": null
}
```

Only that verified request offers `create_ledger_entry` to the model. Its
arguments are `amount` (positive plain decimal text), `currency`, and optional
`payment_method`/`note`. Amounts may contain at most 13 integer digits and two
decimal places; signs, commas, exponents, excess precision and numeric JSON
values are rejected. Text normalization removes leading zeros and pads cents
without rounding. Supported payment methods are `cash`, `bank_transfer`,
`mobile_money` and `other`; notes have at most 500 characters. Either optional
field may be null, and omitted fields become null.

This milestone supports self contributions in the workspace's freshly read
base currency, in active event containers with money tracking enabled for both
the container and the caller's participation. The authenticated membership
must be active, non-deleted and non-proxy. Admins use their real role and follow
the same pending-submission rule. Recurring cycles, foreign currency, expenses,
crypto, acting on behalf of others, force overrides and uploads are outside
this tool. IDs in chat text, search candidates and historical selections do
not select a target; ambiguous container names require an explicit choice.

The server fixes the contributor and container, copies the exact amount into
`original_amount` and `base_amount`, and fixes `entry_type: contribution`,
`cycle_id: null`, `is_crypto: false`, `status: pending`, and null confirmation
fields. The card shows the reviewed eligibility context and complete pending
entry values. Container names and notes remain untrusted display data. The
model cannot supply IDs, a base amount, status, an idempotency key or force.

Proposal creation audits and pauses without inserting an entry. Approval uses
the existing separate endpoint with an empty `{}` body. The service refreshes
workspace currency, member identity/role, container eligibility and own
participation during selection, draft creation and approval, then again before
the native insertion. Changed currency, container identity/version or
participation invalidates the card. These service checks are not atomic with
the INSERT; stronger protection against concurrent eligibility changes needs
a database/RPC design decision and live integration coverage.

The native ledger idempotency key is generated from the server proposal ID.
Existing rows and unique-key race winners must match the exact workspace,
container, contributor/recorder, amounts, currency, note, payment method and
pending state before being returned. Native idempotency must be enabled for
this tool. Repeated approval of one card returns the same verified result
without repeating the entry, notifications or audits. Separately approved
proposals represent separate submissions; the keyed path does not use the
existing ten-minute duplicate heuristic.

Successful submission keeps the existing notification and ledger-submitted
audit flow. Agent proposal/approval audits target the container; the executed
audit targets the newly created ledger entry. Receipts expose the entry ID,
stored amounts as exact decimal text, currency, pending state and recorded
timestamp, without proofs or internal idempotency keys. They confirm submission
and do not imply admin confirmation. Transport, result-verification or
notification/audit uncertainty after insertion retains an irreversible
execution claim; the backend does not repeat or try to repair that money write.

Unit coverage includes strict amount validation, role/scope/eligibility
denials, exact replay binding, stale approvals, uncertain outcomes, scripted
model turns, real-service query boundaries, and mocked HTTP/SSE workflows.
Live Postgres concurrency and live model behavior remain integration/evaluation
work.

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

## Admin task confirmation

After an admin explicitly selects a completed task, send its task/container
pair in the current chat request:

```json
{
  "message": "Confirm completion of the selected task.",
  "selected_task_confirmation": {
    "container_id": "<container-uuid>",
    "task_id": "<task-uuid>"
  },
  "conversation_id": null
}
```

Only this request offers `admin_confirm_task`, with strict empty `{}` model
arguments. The server verifies the current active non-proxy admin, non-deleted
workspace and task, and active task-enabled container. Both event and recurring
containers are supported. An assignee must still have a non-deleted membership
in this workspace; unassigned tasks are supported. The stored completer can
differ from the assignee. This confirms an existing completed state.

The full Tier 3 card preserves every stored task field: title, description,
assignment, due date, completion details, notes, ordering, creator/timestamps,
deletion state and exact ordered proof metadata. Each proof contains its stored
workspace/task file path, name, size, MIME type, uploader and upload time.
References must use the existing scoped upload path and metadata shape;
signed/external URLs and unknown proof fields are rejected. Attachments and
text remain untrusted data. File contents are reviewed by the admin through
existing file access; this tool reads metadata and does not inspect the bytes.

The planned state sets `admin_confirmed_by` to the authenticated admin and
shows `admin_confirmed_at` and `updated_at` as `on_approval`. Existing notes,
proofs, completion state and assignment are preserved. Receipts replace those
markers with verified stored timestamps; the database update trigger can give
`updated_at` a different instant from `admin_confirmed_at`.

Approval uses the existing separate endpoint with an empty `{}` body. Fresh
service reads recheck eligibility and the reviewed task; a conditional UPDATE
matches every task field, including proofs, deletion, confirmation fields and
version. Changed attachments, notes, assignment or task/container state make
the card stale. Related workspace/admin/container/assignee checks are separate
from the task UPDATE, so concurrent related-row changes still need live
Postgres integration coverage and a broader transactional design decision.

The draft checks the eventual executed record against the existing 16 KiB
storage limit, including repeated proof metadata and the receipt. A task that
exceeds this limit must be confirmed through the task interface. Successful
execution requires the native `task.confirmed` audit and retains existing
best-effort assignee notifications, plus the agent's proposal/decision audits.
Duplicate approvals return the same result; transport, returned-state or
post-update audit uncertainty retains the execution claim and never retries
the mutation. Only an explicit successful zero-row UPDATE proves no change.

`selected_task` continues to select the caller's active task for Tier 2
progress. It does not select a completed task for admin confirmation. Chat
text, search candidates, earlier selections, historical cards and receipts
never restore either selection or approve an action. Status and follow-up
receipts remain scoped to the current authenticated admin and workspace.

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
model. They reject parameter, identity, tier and tool overrides. Tier 2/3
approval uses the saved parameters, rereads membership, audits the approval,
verifies the bound state and calls the matching existing domain service.
Tier 4 approval returns a token and requires the separate confirmation step
described above. For one
notification, changes to the reviewed title/type/date/read state invalidate
the proposal and the conditional update cannot rewrite an existing read
timestamp. For mark-all,
every saved ID must still exist, belong to the same recipient/workspace and be
unread before execution. The update filters on only those IDs and then verifies
that every target is read. A target concurrently read elsewhere is already in
the desired final state; a later notification is never included.

Tier 2/3 approval returns `{ data: { proposal_id, status: "executed", result } }`.
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
| `awaiting_confirmation` | The Tier 4 card was approved; a separate typed confirmation is still required. No write occurred. |
| `confirmation_pending` | Typed confirmation is processing, with auditing/revalidation unfinished. No execution was claimed. |
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
new `AUDIT_ACTIONS` entries. Tier 4 adds a dedicated secondary-confirmation
event before execution and retains the actual conversation/session trace.
Metadata identifies the proposal, turn, tool,
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
