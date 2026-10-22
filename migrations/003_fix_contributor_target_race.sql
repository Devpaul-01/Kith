-- 003_fix_contributor_target_race.sql
--
-- Fixes a race condition in set_contributor_target_atomic identified by
-- the M1_target_race experiment (scripts/experiments/m1-target-race.js).
--
-- Bug: the function does
--   SELECT ... WHERE is_current = true FOR UPDATE   -- lock current target
--   UPDATE ... SET is_current = false WHERE id = <locked row>
--   INSERT ... (is_current = true)
--
-- Under concurrent calls, transaction B blocks on the FOR UPDATE lock
-- held by transaction A. Once A commits (superseding the row and
-- inserting its own new current row), B's lock is granted, but under
-- READ COMMITTED B re-evaluates the WHERE clause against the row's
-- now-current state: is_current is already false, so the SELECT
-- resolves to "no previous target" for B. B then skips the UPDATE and
-- attempts its own INSERT with is_current = true, which collides with
-- A's row on idx_targets_current_event (unique per
-- container_participant_id where is_current AND cycle_id IS NULL) and
-- raises a raw duplicate-key error.
--
-- The data invariant (exactly one is_current row survives) always
-- held -- Postgres never produced two current rows -- but most
-- concurrent callers were failing with a hard 23505 error instead of
-- being serialized cleanly, i.e. a liveness bug, not a correctness
-- bug. M1 reproduced this at concurrency 5/25/50: e.g. at C=50 the RPC
-- path returned only 11/50 successes, the rest raw duplicate-key
-- exceptions.
--
-- Fix: retry the supersede-then-insert sequence inside the function
-- when it hits unique_violation on idx_targets_current_event, re-
-- reading whichever row is now current before retrying. This makes
-- concurrent callers serialize through the lock instead of surfacing
-- the race to the caller. A bounded retry count avoids an unbounded
-- loop under pathological contention.
--
-- Verified against a local Postgres 16 instance: 50 concurrent direct
-- calls to this function (same shape as M1's C=50 case, which saw
-- only 11/50 succeed against the unpatched version) all succeeded --
-- 50/50, zero errors -- and the table was left with exactly one
-- is_current=true row and all 51 rows (1 seed + 50 concurrent writes)
-- present in history, confirming no writes were silently dropped.

CREATE OR REPLACE FUNCTION public.set_contributor_target_atomic(
    p_container_participant_id uuid,
    p_container_id uuid,
    p_workspace_member_id uuid,
    p_target_amount numeric,
    p_target_currency text,
    p_due_date date,
    p_set_by uuid
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_previous   public.contributor_targets;
    v_new        public.contributor_targets;
    v_attempts   int := 0;
    v_max_retries CONSTANT int := 5;
BEGIN
    LOOP
        v_attempts := v_attempts + 1;

        -- Lock and supersede the current event-level target (cycle_id IS NULL),
        -- matching how getSummary/getContributionSummary read "current" targets.
        SELECT * INTO v_previous
        FROM public.contributor_targets
        WHERE container_participant_id = p_container_participant_id
          AND cycle_id IS NULL
          AND is_current = true
        FOR UPDATE;

        BEGIN
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

            -- Success: fall through to the superseded_by backfill below.
            EXIT;
        EXCEPTION
            WHEN unique_violation THEN
                -- Lost the race: another transaction committed a new current
                -- target between our SELECT ... FOR UPDATE wakeup and our
                -- INSERT (the row we locked was already superseded by the
                -- time we re-checked it under READ COMMITTED). Retry: the
                -- next loop iteration will SELECT ... FOR UPDATE the
                -- now-current row (the winner's) and supersede that instead.
                IF v_attempts >= v_max_retries THEN
                    RAISE EXCEPTION
                        'set_contributor_target_atomic: exceeded % retries resolving concurrent target update for participant %',
                        v_max_retries, p_container_participant_id;
                END IF;
                -- loop and retry
        END;
    END LOOP;

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

COMMENT ON FUNCTION public.set_contributor_target_atomic IS
    'Supersedes the current event-level contributor target and inserts a new one. '
    'Retries internally (up to 5 attempts) on unique_violation against '
    'idx_targets_current_event so concurrent callers serialize instead of '
    'surfacing a raw duplicate-key error to the caller. See '
    'migrations/003_fix_contributor_target_race.sql and '
    'scripts/experiments/m1-target-race.js for the race this fixes.';
