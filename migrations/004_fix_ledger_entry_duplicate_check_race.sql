-- 004_fix_ledger_entry_duplicate_check_race.sql
--
-- Fixes a race condition in ledger.service.js createEntry(), on the
-- NO-idempotency-key path (the common case: a user submitting a
-- contribution without the client sending an Idempotency-Key header,
-- e.g. a plain double-tap of "submit" on a flaky connection).
--
-- Bug: createEntry() does, from Node, as two separate PostgREST calls
-- with no transaction or lock between them:
--   1. SELECT id FROM ledger_entries
--      WHERE container_id = ? AND contributor_id = ? AND original_amount = ?
--        AND recorded_at >= now() - interval '10 minutes'
--   2. (if nothing found) INSERT ... the new entry
--
-- Two concurrent requests for the same contributor/container/amount
-- both run step 1 before either has committed step 2, both see no
-- existing row, and both proceed to insert -- producing two ledger
-- entries for what should have been deduplicated to one. Unlike the
-- idempotency-key path (which is backed by a real UNIQUE constraint
-- on idempotency_key, and whose 23505 is caught and handled as a
-- clean idempotent replay), there is no database constraint backing
-- this 10-minute duplicate-detection window at all, so nothing stops
-- the second insert and no error is surfaced to either caller.
--
-- Verified locally: two concurrent check-then-insert sequences for
-- the same (container_id, contributor_id, original_amount), run as
-- raw SQL to mirror the app's exact query shape, produced 2 rows
-- instead of 1 -- no error, no conflict, both silently succeeded.
--
-- Fix: push the check-then-insert into a single Postgres function
-- that takes a transaction-scoped advisory lock keyed on
-- (container_id, contributor_id) before checking for a recent
-- duplicate, so concurrent callers for the same contributor serialize
-- through the check instead of racing past it. The lock is released
-- automatically at transaction end (pg_advisory_xact_lock). Callers
-- for *different* contributors are unaffected -- the lock key is
-- scoped per contributor, not global or per-container.
--
-- This does not change the idempotency-key path, which was already
-- correct (see scripts/experiments/m2-idempotency-race.js — 9/9 runs,
-- 0 violations against the existing INSERT + catch(23505) handling).

CREATE OR REPLACE FUNCTION public.create_ledger_entry_checked(
    p_workspace_id      uuid,
    p_container_id      uuid,
    p_cycle_id          uuid,
    p_entry_type        text,
    p_contributor_id    uuid,
    p_original_amount   numeric,
    p_original_currency text,
    p_base_amount       numeric,
    p_payment_method    text,
    p_note              text,
    p_is_crypto         boolean,
    p_status             text,
    p_recorded_by       uuid,
    p_confirmed_at      timestamptz,
    p_confirmed_by      uuid,
    p_dup_window        interval,
    p_force             boolean
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_dup   public.ledger_entries;
    v_entry public.ledger_entries;
BEGIN
    -- Serialize concurrent calls for the same (container, contributor) pair.
    -- hashtextextended gives a well-distributed 64-bit key from the two
    -- uuids; released automatically when this transaction ends.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_container_id::text || ':' || p_contributor_id::text, 0)
    );

    IF NOT p_force THEN
        SELECT * INTO v_dup
        FROM public.ledger_entries
        WHERE container_id = p_container_id
          AND contributor_id = p_contributor_id
          AND original_amount = p_original_amount
          AND recorded_at >= (now() - p_dup_window)
        LIMIT 1;

        IF v_dup.id IS NOT NULL THEN
            RETURN jsonb_build_object('duplicate', true, 'existing_entry_id', v_dup.id);
        END IF;
    END IF;

    INSERT INTO public.ledger_entries (
        workspace_id, container_id, cycle_id, entry_type, contributor_id,
        original_amount, original_currency, base_amount, payment_method,
        note, is_crypto, status, recorded_by, confirmed_at, confirmed_by
    )
    VALUES (
        p_workspace_id, p_container_id, p_cycle_id, p_entry_type, p_contributor_id,
        p_original_amount, p_original_currency, p_base_amount, p_payment_method,
        p_note, p_is_crypto, p_status, p_recorded_by, p_confirmed_at, p_confirmed_by
    )
    RETURNING * INTO v_entry;

    RETURN jsonb_build_object('duplicate', false, 'entry', to_jsonb(v_entry));
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to create ledger entry: %', SQLERRM;
END;
$$;

COMMENT ON FUNCTION public.create_ledger_entry_checked IS
    'Atomically checks the 10-minute duplicate-contribution window and inserts '
    'a new ledger entry, under a pg_advisory_xact_lock keyed on '
    '(container_id, contributor_id), so concurrent no-idempotency-key callers '
    'for the same contributor serialize through the check instead of racing '
    'past it. idempotency_key is intentionally not a parameter here: the '
    'idempotency-key path in ledger.service.js createEntry() continues to use '
    'a plain INSERT, already correctly backed by the UNIQUE constraint on '
    'idempotency_key and the existing 23505 catch-and-replay logic. See '
    'migrations/004_fix_ledger_entry_duplicate_check_race.sql.';
