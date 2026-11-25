# Reviewed dispute raise — approved transactional patch

**Status: approved and implemented** in the consolidated schema
(`migrations/001_schema.sql`) and the reviewed raise service branch. The
repository owner granted full authority to apply proposals, which covers all
three decisions at the end of this document (SQL approved, ordinary RPC
hardened in the same patch, member and admin callers both supported). The SQL
was first validated on a scratch database, then applied to a fresh local
Postgres 16 and covered by `dispute-raise-atomic.test.js`. It has **not been
deployed to any existing database**; existing deployments need the two
`CREATE OR REPLACE` functions and the ACL block applied separately, followed by
a PostgREST schema cache reload.

## Why this patch

`raiseReviewedDispute` rereads workspace, actor, container and entry in the
service, compares them with the approved card, and then calls the **ordinary**
`raise_dispute_atomic`. That RPC locks only the entry and does not recheck the
workspace, actor or container, and it never asserts that its ledger `UPDATE`
changed a row. Verified against the current schema on a local stack:

- **Eligibility drift:** a member deactivated after review still had a dispute
  committed (`ACCEPTED (dispute committed)`). Workspace currency/deletion, role
  or proxy changes and container archive/money-disable are equally unchecked
  between the service read and the RPC. The service's post-mutation comparison
  detects some drift only after the dispute is already committed.
- **Unasserted ledger transition:** with a BEFORE UPDATE trigger suppressing the
  `confirmed → disputed` change, the RPC **returned and committed an open
  dispute while the entry stayed `confirmed`**.

This is the same pattern fixed for reviewed resolution. Confirmed ledger rows
are already frozen by `enforce_ledger_entry_immutability`, so entry financial
drift is not the risk; the surrounding rows and the unasserted update are.

## What changes

1. `raise_dispute_atomic` (ordinary): same signature, result, and error
   messages. Adds a pinned `search_path`, a required `ROW_COUNT = 1` ledger
   transition that raises the existing `ENTRY_NOT_DISPUTABLE` (rolling back the
   inserted dispute), and service-role-only execution. It still accepts
   `confirmed` and `pending` entries for the HTTP route. Its HTTP authorization
   stays in `dispute.service.js`.
2. `raise_dispute_reviewed_atomic` (new, opt-in): accepts server-owned
   identity and the approved snapshot, locks and revalidates workspace, actor,
   container and entry, compares the complete approved projection, inserts the
   dispute, requires the entry transition and returns both verified
   projections from one transaction.

It does not broaden eligibility: the actor's own confirmed, positive,
non-crypto, base-currency contribution with confirmation metadata and no
cycle/correction link, in an active money-enabled event, for an active
non-proxy member (admin or member) with no open dispute. Mutable proofs are
outside the snapshot, as before.

## Locking and failure contract

- Reviewed order: workspace `FOR SHARE` → actor member `FOR SHARE` → container
  `FOR SHARE` → entry `FOR UPDATE` → dispute insert. This is a prefix-compatible
  order with `resolve_dispute_reviewed_atomic` (which adds the dispute `FOR
  UPDATE` last) and with the ordinary raise/resolve RPCs (entry before
  dispute). A normal UPDATE of a locked eligibility row blocks until commit.
- Stale or ineligible state raises `REVIEWED_DISPUTE_STALE` with zero writes.
  Malformed input raises `INVALID_REVIEWED_DISPUTE_INPUT` before locking. The
  partial unique index `idx_disputes_one_open_per_entry` still raises `23505`
  for a racing open dispute.
- The reason must be 5–1000 characters and already trimmed; the service passes
  the trimmed validated reason, as it does now.
- No automatic retry. Required auditing and notification remain in the service
  after the committed mutation; their failure keeps the current uncertainty
  handling.

## Exact proposed SQL

```sql
-- Reviewed dispute raise hardening (PROPOSED — not applied to migrations/001_schema.sql).
--
-- 1. Replaces the ordinary raise_dispute_atomic with the same signature, result
--    and error messages, adding a pinned search_path and a required ledger
--    transition (ROW_COUNT = 1) so a suppressed UPDATE can never leave a dispute
--    row committed beside an undisputed entry.
-- 2. Adds raise_dispute_reviewed_atomic for the agent's reviewed branch. It locks
--    and re-validates workspace, actor/owner, container and entry inside the
--    transaction and compares the exact approved snapshot before any write.
--
-- Lock order (matches resolve_dispute_reviewed_atomic): workspace (share) ->
-- member (share) -> container (share) -> entry (update). The dispute row is
-- inserted last, so the entry lock precedes any dispute write, as in the
-- ordinary raise and resolve RPCs.

CREATE OR REPLACE FUNCTION public.raise_dispute_atomic(p_workspace_id uuid, p_ledger_entry_id uuid, p_raised_by uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
DECLARE
    v_entry   public.ledger_entries;
    v_dispute public.disputes;
    v_count   integer;
BEGIN
    SELECT * INTO v_entry FROM public.ledger_entries
    WHERE id = p_ledger_entry_id AND workspace_id = p_workspace_id
    FOR UPDATE;

    IF v_entry.id IS NULL THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND'; END IF;
    IF v_entry.status NOT IN ('confirmed', 'pending') THEN RAISE EXCEPTION 'ENTRY_NOT_DISPUTABLE'; END IF;
    IF EXISTS (SELECT 1 FROM public.disputes WHERE ledger_entry_id = p_ledger_entry_id AND status = 'open') THEN
        RAISE EXCEPTION 'DISPUTE_ALREADY_OPEN';
    END IF;

    INSERT INTO public.disputes (workspace_id, ledger_entry_id, raised_by, reason, status)
    VALUES (p_workspace_id, p_ledger_entry_id, p_raised_by, p_reason, 'open')
    RETURNING * INTO v_dispute;

    UPDATE public.ledger_entries SET status = 'disputed'
    WHERE id = p_ledger_entry_id AND workspace_id = p_workspace_id
      AND status IN ('confirmed', 'pending');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    -- Raising rolls back the inserted dispute: never commit one without the transition.
    IF v_count <> 1 THEN RAISE EXCEPTION 'ENTRY_NOT_DISPUTABLE'; END IF;

    RETURN to_jsonb(v_dispute);
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_dispute_reviewed_atomic(
    p_workspace_id uuid,
    p_user_id uuid,
    p_raised_by uuid,
    p_reason text,
    p_expected jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_workspace public.workspaces;
    v_actor public.workspace_members;
    v_container public.containers;
    v_entry public.ledger_entries;
    v_dispute public.disputes;
    v_expected jsonb;
    v_current jsonb;
    v_count integer;
BEGIN
    IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_raised_by IS NULL
       OR p_reason IS NULL
       OR char_length(p_reason) NOT BETWEEN 5 AND 1000
       OR p_reason <> btrim(p_reason)
       OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'INVALID_REVIEWED_DISPUTE_INPUT';
    END IF;

    SELECT * INTO v_workspace FROM public.workspaces
    WHERE id = p_workspace_id FOR SHARE;
    SELECT * INTO v_actor FROM public.workspace_members
    WHERE id = p_raised_by FOR SHARE;
    SELECT * INTO v_container FROM public.containers
    WHERE id = (p_expected ->> 'container_id')::uuid FOR SHARE;
    SELECT * INTO v_entry FROM public.ledger_entries
    WHERE id = (p_expected #>> '{entry,entry_id}')::uuid FOR UPDATE;

    IF v_workspace.id IS NULL OR v_workspace.deleted_at IS NOT NULL
       OR v_actor.id IS NULL OR v_actor.workspace_id <> p_workspace_id
       OR v_actor.user_id IS DISTINCT FROM p_user_id
       OR v_actor.role NOT IN ('member', 'admin')
       OR NOT v_actor.is_active OR v_actor.is_proxy OR v_actor.deleted_at IS NOT NULL
       OR v_container.id IS NULL OR v_container.workspace_id <> p_workspace_id
       OR v_container.container_type <> 'event' OR v_container.status <> 'active'
       OR NOT v_container.enable_money OR v_container.deleted_at IS NOT NULL
       OR v_entry.id IS NULL OR v_entry.workspace_id <> p_workspace_id
       OR v_entry.container_id <> v_container.id
       OR v_entry.contributor_id IS DISTINCT FROM v_actor.id
       OR v_entry.entry_type <> 'contribution' OR v_entry.status <> 'confirmed'
       OR v_entry.original_amount <= 0
       OR v_entry.original_currency <> v_workspace.base_currency
       OR v_entry.original_amount <> v_entry.base_amount OR v_entry.is_crypto
       OR v_entry.payment_method = 'crypto' OR v_entry.cycle_id IS NOT NULL
       OR v_entry.corrects_entry_id IS NOT NULL
       OR v_entry.confirmed_at IS NULL OR v_entry.confirmed_by IS NULL
       OR EXISTS (SELECT 1 FROM public.disputes
                  WHERE ledger_entry_id = v_entry.id AND status = 'open') THEN
        RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE';
    END IF;

    -- Mirror the service's strict raise selection exactly: no proof, note or
    -- private-key snapshots. Explicit text casts preserve numeric(15,2) decimals.
    v_current := jsonb_build_object(
        'workspace_id', v_workspace.id, 'workspace_name', v_workspace.name,
        'workspace_updated_at', v_workspace.updated_at,
        'base_currency', v_workspace.base_currency,
        'actor_member_id', v_actor.id, 'member_role', v_actor.role,
        'actor_display_name', v_actor.display_name, 'member_updated_at', v_actor.updated_at,
        'container_id', v_container.id, 'container_name', v_container.name,
        'container_type', v_container.container_type, 'container_status', v_container.status,
        'enable_money', v_container.enable_money, 'container_updated_at', v_container.updated_at,
        'entry', (to_jsonb(v_entry) - ARRAY['id', 'proofs', 'idempotency_key'])
            || jsonb_build_object('entry_id', v_entry.id,
                'original_amount', v_entry.original_amount::text, 'base_amount', v_entry.base_amount::text),
        'dispute', 'null'::jsonb
    );
    -- Normalize only formatting of known timestamp fields, not financial values
    -- or arbitrary text. Missing/extra expected fields still fail equality.
    v_expected := p_expected || jsonb_build_object(
        'workspace_updated_at', (p_expected ->> 'workspace_updated_at')::timestamptz,
        'member_updated_at', (p_expected ->> 'member_updated_at')::timestamptz,
        'container_updated_at', (p_expected ->> 'container_updated_at')::timestamptz,
        'entry', (p_expected -> 'entry') || jsonb_build_object(
            'recorded_at', (p_expected #>> '{entry,recorded_at}')::timestamptz,
            'confirmed_at', (p_expected #>> '{entry,confirmed_at}')::timestamptz)
    );
    IF v_current IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE';
    END IF;

    INSERT INTO public.disputes (workspace_id, ledger_entry_id, raised_by, reason, status)
    VALUES (p_workspace_id, v_entry.id, v_actor.id, p_reason, 'open')
    RETURNING * INTO v_dispute;

    UPDATE public.ledger_entries SET status = 'disputed'
    WHERE id = v_entry.id AND workspace_id = p_workspace_id
      AND container_id = v_container.id AND status = 'confirmed'
    RETURNING * INTO v_entry;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'REVIEWED_DISPUTE_STALE'; END IF;

    RETURN jsonb_build_object(
        'entry', (to_jsonb(v_entry) - ARRAY['id', 'proofs', 'idempotency_key'])
            || jsonb_build_object('entry_id', v_entry.id,
                'original_amount', v_entry.original_amount::text, 'base_amount', v_entry.base_amount::text),
        'dispute', (to_jsonb(v_dispute) - 'id') || jsonb_build_object('dispute_id', v_dispute.id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.raise_dispute_atomic(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.raise_dispute_reviewed_atomic(uuid, uuid, uuid, text, jsonb) FROM PUBLIC;
DO $$
DECLARE v_role text;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.raise_dispute_atomic(uuid, uuid, uuid, text) FROM %I', v_role);
            EXECUTE format('REVOKE ALL ON FUNCTION public.raise_dispute_reviewed_atomic(uuid, uuid, uuid, text, jsonb) FROM %I', v_role);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.raise_dispute_atomic(uuid, uuid, uuid, text) TO service_role;
        GRANT EXECUTE ON FUNCTION public.raise_dispute_reviewed_atomic(uuid, uuid, uuid, text, jsonb) TO service_role;
    END IF;
END;
$$;
```

## Service wiring (implemented with this patch)

- `raiseReviewedDispute` keeps its current validation and `getRaiseDisputeContext`
  pre-check, then calls `raise_dispute_reviewed_atomic` with
  `p_workspace_id`, `p_user_id`, `p_raised_by`, the trimmed reason and the
  approved snapshot as `p_expected`.
- `23505` and P0001 `REVIEWED_DISPUTE_STALE` map to the existing
  `ConflictError`; every other RPC, transport or malformed-response outcome
  keeps the current unavailable/uncertain handling.
- The receipt's dispute and entry come from the RPC's returned projections,
  validated against the planned state; the separate post-mutation entry read is
  removed. Required audit and the best-effort admin notification are unchanged.
- The ordinary route, `AGENT` Tier 4 card, receipt contract and API are
  unchanged.

## Validation performed

Unpatched schema (behaviour before this patch): both gaps above reproduced.
Patched schema, the committed `dispute-raise-atomic.test.js` suite (22 cases)
covers:

- Exact entry/dispute projections; entry disputed and dispute open afterward.
- Nine stale cases with zero writes: workspace currency changed/deleted, actor
  deactivated/promoted/converted to proxy, container archived/money-disabled/
  deleted, and an already-open dispute; plus a tampered snapshot.
- Invalid reason inputs rejected before any write.
- Suppressed ledger transition rolls back the dispute (reviewed and ordinary).
- Observed lock waits in both orderings: a held reviewed lock blocks a
  competing eligibility edit until commit; an edit committed while the reviewed
  call waits yields stale with zero writes.
- Two concurrent reviewed calls, and an ordinary-versus-reviewed race, leave
  exactly one dispute. (This alone is also guaranteed by the unique index; the
  lock-wait cases above are the substantive TOCTOU evidence.)
- Ordinary result shape and legacy error messages preserved; both functions
  have a pinned search path and no `PUBLIC` execute.

These ran on a local Postgres/PostgREST/Redis stack, not CI. Test-created
fixtures do not certify target Supabase roles, so deployment ACL inspection
remains a separate gate. The service boundary unit suite was updated to the new
contract: reviewed RPC name and parameters, typed `REVIEWED_DISPUTE_STALE`/
`23505` as the only definite rejections, RPC-sourced projections, and audit
only after the result is verified.

## Decisions (all approved)

1. Approve this exact SQL for `migrations/001_schema.sql`.
2. Approve hardening the ordinary `raise_dispute_atomic` in the same patch
   (same contract plus the required transition and service-role-only grants),
   or limit the patch to the new reviewed function.
3. Confirm `member` and `admin` callers both remain supported for reviewed
   raise, as in the current Tier 4 flow.
