# Reviewed dispute resolution — approved transactional patch

**Status: implemented in the consolidated schema and reviewed service branch.
Applied to and exercised on a local Postgres 16 stack (see coverage below); not
deployed to any existing database.** The user
approved implementation on 2026-11-18. This document records the exact patch,
not a migration runner or authorization to deploy it to an existing database.

## Why this patch

Before hardening, the reviewed service rechecked workspace, admin, owner, event
and both records, then called `resolve_dispute_atomic`. That RPC updated the
dispute first and did not require its conditional ledger update to affect a
row. A valid post-read could detect a mismatch but could not undo a committed
partial resolution. Eligibility could also change between reads and mutation.

The new opt-in `resolve_dispute_reviewed_atomic` accepts only server-owned,
strictly validated selection state and authenticated identity. It compares the
complete approved projections while holding row locks and returns both verified
projections from the same transaction. It does not broaden eligibility: owner-
raised, positive base-currency non-crypto contributions with confirmation
metadata, no cycle/correction link, active non-proxy owner and admin, active
money-enabled event. Mutable proofs and appended notes remain outside review.

The existing resolver must also acquire its entry lock before its dispute lock:
`raise_dispute_atomic` already locks the entry before inserting a dispute.
Retaining the old dispute-first resolver would allow conflicting lock order.
The replacement below preserves its four parameters and ordinary dispute-only
return shape; it adds a required ledger transition and pins its search path.
It does not move ordinary HTTP authorization into the RPC.

## Locking and failure contract

- Reviewed order: workspace `FOR SHARE` → actor/owner member IDs in ascending
  order `FOR SHARE` → container `FOR SHARE` → entry `FOR UPDATE` → dispute
  `FOR UPDATE`. Same actor/owner is locked once.
- Ordinary raise and the replacement ordinary resolve acquire entry before
  dispute. Ordinary FK `KEY SHARE` locks are compatible with the reviewed
  parent/member `SHARE` locks. A normal UPDATE/DELETE of a locked eligibility
  row blocks even when its writer does not know about the agent.
- After a competing edit commits first, the locked current projection is
  compared against the expected snapshot and rejects without writing. If
  resolution commits first, a later lifecycle write is a later operation;
  this patch does not retroactively cancel it or make its prechecks atomic.
- Rechecks occur after all locks are held. Every required UPDATE must return
  exactly one row. Any exception rolls back both transitions.
- Only null-data PostgreSQL `P0001` with exact message
  `REVIEWED_DISPUTE_STALE` proves a reviewed stale/no-write outcome. Invalid
  payloads/casts, lock/deadlock/transport errors and malformed responses remain
  unavailable/indeterminate at the agent boundary, never auto-replayed.
- Parent timestamps are compared as exact PostgreSQL instants; stored decimal
  strings remain strings. Result timestamps come verbatim from PostgreSQL.
- Required native `dispute.resolved` auditing remains in `audit.log()` after
  the RPC, followed by the existing saved-result/final-agent-audit protocol.
  Audit/Redis uncertainty still retains the irreversible claim. This patch
  does **not** promise transactionally committed audit events or durable replay
  recovery. A durable execution marker/audit redesign needs separate approval.
- Reviewed raise hardening remains a separate subsequent slice. This proposal
  does not claim that its current pre-RPC related-row checks are transactional.

## Exact approved SQL in the consolidated schema

Replace the existing `resolve_dispute_atomic` definition with the first function,
then add the reviewed function and ACL block beside it. For an existing database,
apply only this reviewed patch after deployment approval, never replay the whole
consolidated schema. `CREATE OR REPLACE` below supports that targeted deployment.

```sql
CREATE OR REPLACE FUNCTION public.resolve_dispute_atomic(
    p_dispute_id uuid,
    p_resolution_note text,
    p_resolved_by uuid,
    p_resolved_at timestamp with time zone
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_initial public.disputes;
    v_dispute public.disputes;
    v_entry public.ledger_entries;
    v_count integer;
BEGIN
    -- Read linkage without taking a dispute lock ahead of the entry lock.
    SELECT * INTO v_initial FROM public.disputes
    WHERE id = p_dispute_id AND status = 'open';
    IF v_initial.id IS NULL THEN
        RAISE EXCEPTION 'Dispute % not found or already resolved', p_dispute_id;
    END IF;

    SELECT * INTO v_entry FROM public.ledger_entries
    WHERE id = v_initial.ledger_entry_id
      AND workspace_id = v_initial.workspace_id
    FOR UPDATE;

    SELECT * INTO v_dispute FROM public.disputes
    WHERE id = p_dispute_id AND status = 'open'
      AND workspace_id = v_initial.workspace_id
      AND ledger_entry_id = v_initial.ledger_entry_id
    FOR UPDATE;
    IF v_dispute.id IS NULL THEN
        RAISE EXCEPTION 'Dispute % not found or already resolved', p_dispute_id;
    END IF;
    IF v_entry.id IS NULL OR v_entry.status <> 'disputed' THEN
        RAISE EXCEPTION 'Dispute % has no disputed ledger entry', p_dispute_id;
    END IF;

    UPDATE public.ledger_entries SET status = 'resolved'
    WHERE id = v_entry.id AND workspace_id = v_dispute.workspace_id
      AND status = 'disputed'
    RETURNING * INTO v_entry;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Dispute % has no disputed ledger entry', p_dispute_id;
    END IF;

    UPDATE public.disputes
    SET status = 'resolved', resolution_note = p_resolution_note,
        resolved_by = p_resolved_by, resolved_at = p_resolved_at
    WHERE id = p_dispute_id AND workspace_id = v_initial.workspace_id
      AND ledger_entry_id = v_entry.id AND status = 'open'
    RETURNING * INTO v_dispute;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Dispute % not found or already resolved', p_dispute_id;
    END IF;
    RETURN to_jsonb(v_dispute);
EXCEPTION WHEN OTHERS THEN
    -- Keep the existing ordinary resolver's error envelope.
    RAISE EXCEPTION 'Failed to resolve dispute: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_dispute_reviewed_atomic(
    p_workspace_id uuid,
    p_dispute_id uuid,
    p_user_id uuid,
    p_resolved_by uuid,
    p_resolution_note text,
    p_resolved_at timestamp with time zone,
    p_expected jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_workspace public.workspaces;
    v_actor public.workspace_members;
    v_owner public.workspace_members;
    v_container public.containers;
    v_entry public.ledger_entries;
    v_dispute public.disputes;
    v_owner_id uuid;
    v_expected jsonb;
    v_current jsonb;
    v_count integer;
BEGIN
    IF p_workspace_id IS NULL OR p_dispute_id IS NULL OR p_user_id IS NULL
       OR p_resolved_by IS NULL OR p_resolved_at IS NULL
       OR NOT isfinite(p_resolved_at)
       OR p_resolution_note IS NULL
       OR char_length(p_resolution_note) NOT BETWEEN 10 AND 1000
       OR p_resolution_note <> btrim(p_resolution_note)
       OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'INVALID_REVIEWED_DISPUTE_INPUT';
    END IF;
    v_owner_id := (p_expected #>> '{entry,contributor_id}')::uuid;

    SELECT * INTO v_workspace FROM public.workspaces
    WHERE id = p_workspace_id FOR SHARE;
    -- ORDER BY prevents two reviewed actions locking shared actors in reverse.
    PERFORM id FROM public.workspace_members
    WHERE id IN (p_resolved_by, v_owner_id)
    ORDER BY id FOR SHARE;
    SELECT * INTO v_actor FROM public.workspace_members WHERE id = p_resolved_by;
    SELECT * INTO v_owner FROM public.workspace_members WHERE id = v_owner_id;
    SELECT * INTO v_container FROM public.containers
    WHERE id = (p_expected ->> 'container_id')::uuid FOR SHARE;
    SELECT * INTO v_entry FROM public.ledger_entries
    WHERE id = (p_expected #>> '{entry,entry_id}')::uuid FOR UPDATE;
    SELECT * INTO v_dispute FROM public.disputes
    WHERE id = p_dispute_id FOR UPDATE;

    IF v_workspace.id IS NULL OR v_workspace.deleted_at IS NOT NULL
       OR v_actor.id IS NULL OR v_actor.workspace_id <> p_workspace_id
       OR v_actor.user_id IS DISTINCT FROM p_user_id OR v_actor.role <> 'admin'
       OR NOT v_actor.is_active OR v_actor.is_proxy OR v_actor.deleted_at IS NOT NULL
       OR v_owner.id IS NULL OR v_owner.workspace_id <> p_workspace_id
       OR NOT v_owner.is_active OR v_owner.is_proxy OR v_owner.deleted_at IS NOT NULL
       OR v_container.id IS NULL OR v_container.workspace_id <> p_workspace_id
       OR v_container.container_type <> 'event' OR v_container.status <> 'active'
       OR NOT v_container.enable_money OR v_container.deleted_at IS NOT NULL
       OR v_entry.id IS NULL OR v_entry.workspace_id <> p_workspace_id
       OR v_entry.container_id <> v_container.id
       OR v_entry.contributor_id IS DISTINCT FROM v_owner.id
       OR v_entry.entry_type <> 'contribution' OR v_entry.status <> 'disputed'
       OR v_entry.original_amount <= 0
       OR v_entry.original_currency <> v_workspace.base_currency
       OR v_entry.original_amount <> v_entry.base_amount OR v_entry.is_crypto
       OR v_entry.payment_method = 'crypto' OR v_entry.cycle_id IS NOT NULL
       OR v_entry.corrects_entry_id IS NOT NULL
       OR v_entry.confirmed_at IS NULL OR v_entry.confirmed_by IS NULL
       OR v_dispute.id IS NULL OR v_dispute.workspace_id <> p_workspace_id
       OR v_dispute.ledger_entry_id <> v_entry.id
       OR v_dispute.raised_by <> v_owner.id OR v_dispute.status <> 'open'
       OR v_dispute.resolution_note IS NOT NULL OR v_dispute.resolved_by IS NOT NULL
       OR v_dispute.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE';
    END IF;

    -- Match the service's complete strict selection. No proof/note/private-key
    -- snapshots are added. Explicit text casts preserve numeric(15,2) decimals.
    v_current := jsonb_build_object(
        'workspace_id', v_workspace.id, 'workspace_name', v_workspace.name,
        'workspace_updated_at', v_workspace.updated_at,
        'base_currency', v_workspace.base_currency,
        'actor_member_id', v_actor.id, 'member_role', v_actor.role,
        'actor_display_name', v_actor.display_name, 'member_updated_at', v_actor.updated_at,
        'container_id', v_container.id, 'container_name', v_container.name,
        'container_type', v_container.container_type, 'container_status', v_container.status,
        'enable_money', v_container.enable_money, 'container_updated_at', v_container.updated_at,
        'contributor_display_name', v_owner.display_name,
        'contributor_role', v_owner.role, 'contributor_updated_at', v_owner.updated_at,
        'entry', (to_jsonb(v_entry) - ARRAY['id', 'proofs', 'idempotency_key'])
            || jsonb_build_object('entry_id', v_entry.id,
                'original_amount', v_entry.original_amount::text, 'base_amount', v_entry.base_amount::text),
        'dispute', (to_jsonb(v_dispute) - ARRAY['id', 'notes'])
            || jsonb_build_object('dispute_id', v_dispute.id)
    );
    -- Normalize only formatting of known timestamp fields, not financial values
    -- or arbitrary text. Missing/extra expected fields still fail equality.
    v_expected := p_expected || jsonb_build_object(
        'workspace_updated_at', (p_expected ->> 'workspace_updated_at')::timestamptz,
        'member_updated_at', (p_expected ->> 'member_updated_at')::timestamptz,
        'container_updated_at', (p_expected ->> 'container_updated_at')::timestamptz,
        'contributor_updated_at', (p_expected ->> 'contributor_updated_at')::timestamptz,
        'entry', (p_expected -> 'entry') || jsonb_build_object(
            'recorded_at', (p_expected #>> '{entry,recorded_at}')::timestamptz,
            'confirmed_at', (p_expected #>> '{entry,confirmed_at}')::timestamptz),
        'dispute', (p_expected -> 'dispute') || jsonb_build_object(
            'raised_at', (p_expected #>> '{dispute,raised_at}')::timestamptz)
    );
    IF v_current IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE';
    END IF;

    UPDATE public.ledger_entries SET status = 'resolved'
    WHERE id = v_entry.id AND workspace_id = p_workspace_id
      AND container_id = v_container.id AND status = 'disputed'
    RETURNING * INTO v_entry;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE'; END IF;

    UPDATE public.disputes
    SET status = 'resolved', resolution_note = p_resolution_note,
        resolved_by = p_resolved_by, resolved_at = p_resolved_at
    WHERE id = p_dispute_id AND workspace_id = p_workspace_id
      AND ledger_entry_id = v_entry.id AND raised_by = v_owner.id AND status = 'open'
    RETURNING * INTO v_dispute;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE'; END IF;

    RETURN jsonb_build_object(
        'entry', (to_jsonb(v_entry) - ARRAY['id', 'proofs', 'idempotency_key'])
            || jsonb_build_object('entry_id', v_entry.id,
                'original_amount', v_entry.original_amount::text, 'base_amount', v_entry.base_amount::text),
        'dispute', (to_jsonb(v_dispute) - ARRAY['id', 'notes'])
            || jsonb_build_object('dispute_id', v_dispute.id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_dispute_atomic(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_dispute_reviewed_atomic(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) FROM PUBLIC;
DO $$
DECLARE v_role text;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.resolve_dispute_atomic(uuid, text, uuid, timestamptz) FROM %I', v_role);
            EXECUTE format('REVOKE ALL ON FUNCTION public.resolve_dispute_reviewed_atomic(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) FROM %I', v_role);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.resolve_dispute_atomic(uuid, text, uuid, timestamptz) TO service_role;
        GRANT EXECUTE ON FUNCTION public.resolve_dispute_reviewed_atomic(uuid, uuid, uuid, uuid, text, timestamptz, jsonb) TO service_role;
    END IF;
END;
$$;
```

## Service wiring accompanying approval of this patch

1. Keep explicit handler authorization, `getResolveDisputeContext`, strict
   selection/argument validation, and proposal revalidation. These remain the
   authorization boundary; SQL is not a substitute.
2. Only the opt-in reviewed branch calls `resolve_dispute_reviewed_atomic` with
   `workspaceId`, `disputeId`, authenticated `userId`/member ID, exact approved
   note, server-generated `resolvedAt` and validated `expected` snapshot.
3. Validate the returned `{ dispute, entry }` with the existing strict result
   schema and exact approved before/after checks, including the exact resolution
   instant. Do not certify a newer post-read as this transaction's result.
4. Require the existing native audit with stored proposal/session/conversation
   IDs; preserve notification deduplication. Adapt the internal reviewed service
   return/handler projection to the RPC's whitelisted result. Ordinary HTTP
   callers still receive the full dispute-only row.
5. Classify only the exact reviewed stale rejection as `ConflictError`; preserve
   uncertainty for all other RPC/audit/storage failures. No automatic retry.

## Regression coverage (executed on a local Postgres 16 / PostgREST / Redis stack)

`tests/integration/database/dispute-resolution-atomic.test.js` uses real direct
Postgres sessions with observed lock waits, finite timeouts and rollback-only
trigger/role fixtures. A local run of the three dispute integration suites passed
(44 tests); this is not a CI or target-database result. `dispute-proposals.test.js` now exercises the reviewed
RPC through the real service/proposal layer. Deployment ACL inspection remains
a separate gate; test-created roles do not certify target role inheritance.

- Missing/non-disputed expected ledger transition: **neither** record changes.
- Ordinary HTTP resolution racing reviewed resolution: one verified transition;
  losing reviewed execution is stale, never a fabricated receipt.
- Ordinary raise vs resolver lock order; no entry/dispute lock inversion.
- Workspace currency/deletion, admin revocation, owner deactivation/proxy switch,
  and event archive/money-disable committed before the reviewed locks: stale and
  zero writes. A held reviewed lock blocks a competing ordinary UPDATE until
  commit; test both orderings rather than two duplicate agent approvals only.
- Dispute reason/linkage/resolution changed during execution: stale/no write.
- Proof-only and appended-note changes remain eligible, preserved, unexposed.
- Exact decimal and timestamp projections; returned postconditions and ordinary
  signature/return/error compatibility.
- Execution denied to real `anon`/`authenticated` roles; allowed to the configured
  service role. The existing test stack authenticates as `postgres` (owner), so
  a passing owner call alone does not prove deployment ACLs.
- Required native/final audit and lost-response regressions from
  `tests/integration/database/dispute-proposals.test.js` remain conservative.

Before deployment, inspect existing explicit function grants (beyond the listed
roles), owner and role inheritance; revoke unintended execution privileges.
Confirm the backend's configured JWT actually selects `service_role`. Apply the
approved targeted patch on an isolated database, run tests, then separately
approve target deployment and issue `NOTIFY pgrst, 'reload schema'`. No target
DB/schema/ranked-search/ACL verification has been performed in this slice.
