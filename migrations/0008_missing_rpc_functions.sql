-- 0008_missing_rpc_functions.sql
--
-- Fixes audit finding 8.3 / the "unverifiable RPCs" gap: six Postgres
-- functions are called via supabaseAdmin.rpc(...) from the application
-- but were absent from schema.sql (which explicitly excludes app-logic
-- functions other than create_workspace_with_admin).
--
-- IMPORTANT: these were NOT available for direct comparison — they are
-- reconstructed from:
--   - the exact parameter names/order used at each .rpc() call site
--   - the inline comments describing what each RPC is supposed to do
--     atomically (e.g. dispute.controller.js, participant.controller.js)
--   - the columns/constraints those comments imply must be touched
--     together in one transaction
--
-- Each function is a single SQL statement (or a small plpgsql block)
-- wrapped in an implicit transaction, which is how Postgres functions
-- behave by default — no explicit BEGIN/COMMIT needed inside a function
-- body. SECURITY DEFINER is used consistently with
-- create_workspace_with_admin (the one RPC that WAS in schema.sql), since
-- these are all called exclusively from supabaseAdmin (service role)
-- which already bypasses RLS — SECURITY DEFINER doesn't change the
-- authorization model here, app-layer checks (requireAdmin etc.) remain
-- the sole enforcement point, exactly as documented in audit finding 8.3.
--
-- Please diff these against your real originals if you have them
-- anywhere (git history, a database console migration log, etc.) before
-- relying on this file as the source of truth.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. raise_dispute_atomic
--    Called from: dispute.controller.js#raiseDispute
--    Inserts the dispute row AND flips the ledger entry to 'disputed' in
--    one transaction, so a failure partway through can't leave an orphan
--    dispute with the entry still 'pending'/'confirmed'.
--    Returns: the newly-created dispute row (as jsonb).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.raise_dispute_atomic(
    p_workspace_id     uuid,
    p_ledger_entry_id  uuid,
    p_raised_by        uuid,
    p_reason           text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_dispute public.disputes;
BEGIN
    INSERT INTO public.disputes (
        workspace_id, ledger_entry_id, raised_by, reason, status
    )
    VALUES (
        p_workspace_id, p_ledger_entry_id, p_raised_by, p_reason, 'open'
    )
    RETURNING * INTO v_dispute;

    UPDATE public.ledger_entries
    SET status = 'disputed'
    WHERE id = p_ledger_entry_id
      AND workspace_id = p_workspace_id;

    RETURN to_jsonb(v_dispute);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to raise dispute: %', SQLERRM;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 2. resolve_dispute_atomic
--    Called from: dispute.controller.js#resolveDispute
--    Marks the dispute resolved AND moves the ledger entry out of
--    'disputed' back into 'resolved' (a distinct terminal status from
--    'confirmed' per ledger_entries_status_check) in one transaction.
--    Returns: the updated dispute row (as jsonb).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_dispute_atomic(
    p_dispute_id      uuid,
    p_resolution_note text,
    p_resolved_by     uuid,
    p_resolved_at     timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_dispute public.disputes;
BEGIN
    UPDATE public.disputes
    SET status          = 'resolved',
        resolution_note = p_resolution_note,
        resolved_by     = p_resolved_by,
        resolved_at     = p_resolved_at
    WHERE id = p_dispute_id
      AND status = 'open'
    RETURNING * INTO v_dispute;

    IF v_dispute.id IS NULL THEN
        RAISE EXCEPTION 'Dispute % not found or already resolved', p_dispute_id;
    END IF;

    UPDATE public.ledger_entries
    SET status = 'resolved'
    WHERE id = v_dispute.ledger_entry_id
      AND status = 'disputed';

    RETURN to_jsonb(v_dispute);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to resolve dispute: %', SQLERRM;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 3. convert_event_to_recurring_atomic
--    Called from: container.controller.js#convertToRecurring
--    Creates the new recurring container AND copies participants across
--    from the source event container in one transaction, so a failure
--    partway through can't leave an orphan recurring container with no
--    participants.
--    Returns: the newly-created container row (as jsonb).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.convert_event_to_recurring_atomic(
    p_source_container_id   uuid,
    p_workspace_id          uuid,
    p_new_name              text,
    p_recurrence_cadence    text,
    p_recurrence_days       integer,
    p_recurrence_start      date,
    p_recurrence_end        date,
    p_carry_forward_unpaid  boolean,
    p_created_by            uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_source    public.containers;
    v_new       public.containers;
BEGIN
    SELECT * INTO v_source
    FROM public.containers
    WHERE id = p_source_container_id
      AND workspace_id = p_workspace_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF v_source.id IS NULL THEN
        RAISE EXCEPTION 'Source container % not found', p_source_container_id;
    END IF;

    INSERT INTO public.containers (
        workspace_id, name, subtitle, description, container_type,
        enable_money, enable_tasks,
        event_type_category,
        recurrence_cadence, recurrence_days, recurrence_start, recurrence_end,
        carry_forward_unpaid, auto_generate_cycles,
        budget_target, budget_currency,
        converted_from_id, created_by
    )
    VALUES (
        p_workspace_id, p_new_name, v_source.subtitle, v_source.description, 'recurring',
        v_source.enable_money, v_source.enable_tasks,
        v_source.event_type_category,
        p_recurrence_cadence, p_recurrence_days, p_recurrence_start, p_recurrence_end,
        p_carry_forward_unpaid, true,
        v_source.budget_target, v_source.budget_currency,
        p_source_container_id, p_created_by
    )
    RETURNING * INTO v_new;

    -- Copy participants across (targets are intentionally NOT copied —
    -- the new recurring container's per-cycle targets are set up by the
    -- normal set-target flow / cycle-generation worker, not carried over
    -- verbatim from the one-off event's targets).
    INSERT INTO public.container_participants (
        container_id, workspace_member_id, role, money_enabled, tasks_enabled,
        notes, exclude_from_public, added_by
    )
    SELECT
        v_new.id, cp.workspace_member_id, cp.role, cp.money_enabled, cp.tasks_enabled,
        cp.notes, cp.exclude_from_public, p_created_by
    FROM public.container_participants cp
    WHERE cp.container_id = p_source_container_id;

    RETURN to_jsonb(v_new);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to convert container to recurring: %', SQLERRM;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 4. upsert_primary_contact
--    Called from: auth.controller.js#upsertContact
--    If p_is_primary is true, demotes any other contact of the same
--    (user_id, type) to is_primary = false, THEN upserts the target
--    contact — atomically, so two concurrent calls can't both end up
--    is_primary = true for the same contact type.
--    Returns: the upserted contact row (as jsonb).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_primary_contact(
    p_user_id      uuid,
    p_type         text,
    p_value        text,
    p_label        text,
    p_country_code text,
    p_is_primary   boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_contact public.user_contacts;
BEGIN
    IF p_is_primary THEN
        UPDATE public.user_contacts
        SET is_primary = false
        WHERE user_id = p_user_id
          AND type = p_type
          AND value <> p_value;
    END IF;

    INSERT INTO public.user_contacts (
        user_id, type, value, label, country_code, is_primary
    )
    VALUES (
        p_user_id, p_type, p_value, p_label, p_country_code, p_is_primary
    )
    ON CONFLICT (user_id, type, value)
    DO UPDATE SET
        label        = EXCLUDED.label,
        country_code = EXCLUDED.country_code,
        is_primary   = EXCLUDED.is_primary
    RETURNING * INTO v_contact;

    RETURN to_jsonb(v_contact);
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to upsert contact: %', SQLERRM;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 5. replace_user_contacts_atomic
--    Called from: auth.controller.js#updateContacts
--    Bulk-replaces every contact of the given types for a user: deletes
--    existing rows of those types, inserts the new set, in one
--    transaction (previously a non-atomic DELETE-then-UPSERT — Issue
--    M17 in the audit).
--    Returns: the newly-inserted contact rows (as a jsonb array).
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.replace_user_contacts_atomic(
    p_user_id  uuid,
    p_types    text[],
    p_contacts jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_result jsonb;
BEGIN
    DELETE FROM public.user_contacts
    WHERE user_id = p_user_id
      AND type = ANY(p_types);

    INSERT INTO public.user_contacts (
        user_id, type, value, label, country_code, is_primary
    )
    SELECT
        p_user_id,
        (c->>'type')::text,
        (c->>'value')::text,
        NULLIF(c->>'label', ''),
        NULLIF(c->>'country_code', ''),
        COALESCE((c->>'is_primary')::boolean, false)
    FROM jsonb_array_elements(p_contacts) AS c;

    SELECT COALESCE(jsonb_agg(to_jsonb(uc)), '[]'::jsonb)
    INTO v_result
    FROM public.user_contacts uc
    WHERE uc.user_id = p_user_id
      AND uc.type = ANY(p_types);

    RETURN v_result;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to replace user contacts: %', SQLERRM;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 6. set_contributor_target_atomic
--    Called from: participant.controller.js#setTarget
--    Supersedes the current target (is_current = false, superseded_at,
--    superseded_by) and inserts the new current target in one
--    transaction — previously 3 sequential non-transactional writes
--    (Issue H1 in the audit) that could leave a participant with NO
--    current target if the insert failed after the supersede succeeded.
--    Respects the partial unique indexes idx_targets_current_cycle /
--    idx_targets_current_event (only one is_current=true row per
--    participant per cycle, or per participant when cycle_id IS NULL).
--    Returns: { new_target, previous_target } as jsonb.
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_contributor_target_atomic(
    p_container_participant_id  uuid,
    p_container_id              uuid,
    p_workspace_member_id       uuid,
    p_target_amount             numeric,
    p_target_currency           text,
    p_due_date                  date,
    p_set_by                    uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_previous public.contributor_targets;
    v_new      public.contributor_targets;
BEGIN
    -- Lock and supersede the current event-level target (cycle_id IS NULL),
    -- matching how getSummary/getContributionSummary read "current" targets.
    SELECT * INTO v_previous
    FROM public.contributor_targets
    WHERE container_participant_id = p_container_participant_id
      AND cycle_id IS NULL
      AND is_current = true
    FOR UPDATE;

    IF v_previous.id IS NOT NULL THEN
        UPDATE public.contributor_targets
        SET is_current    = false,
            superseded_at = now()
        WHERE id = v_previous.id;
    END IF;

    INSERT INTO public.contributor_targets (
        container_participant_id, container_id, workspace_member_id,
        cycle_id, target_amount, target_currency, due_date,
        is_current, set_by
    )
    VALUES (
        p_container_participant_id, p_container_id, p_workspace_member_id,
        NULL, p_target_amount, p_target_currency, p_due_date,
        true, p_set_by
    )
    RETURNING * INTO v_new;

    IF v_previous.id IS NOT NULL THEN
        UPDATE public.contributor_targets
        SET superseded_by = v_new.id
        WHERE id = v_previous.id;

        v_previous.superseded_by := v_new.id;
    END IF;

    RETURN jsonb_build_object(
        'new_target',      to_jsonb(v_new),
        'previous_target', CASE WHEN v_previous.id IS NULL THEN NULL ELSE to_jsonb(v_previous) END
    );
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to set contributor target: %', SQLERRM;
END;
$$;

COMMIT;
