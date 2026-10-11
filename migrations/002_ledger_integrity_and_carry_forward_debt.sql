-- =====================================================================
-- 002: Ledger entry immutability (DB-level) + carry-forward-as-debt
-- =====================================================================
--
-- Two independent fixes, bundled in one migration because both touch
-- the money model:
--
--   1. A confirmed ledger entry can currently be mutated by anything
--      holding the service-role key, because "confirmed entries are
--      corrected, not edited" is only enforced in ledger.service.js
--      (updateEntry/deleteEntry). This adds the same rule as a
--      trigger, so it holds regardless of which code path (or SQL
--      console) touches the row.
--
--   2. carryForwardUnpaid() used to insert a `ledger_entries` row with
--      status='confirmed' for the OUTSTANDING amount. Since every
--      summary/report in this app treats status='confirmed' as "money
--      received", that made an unpaid participant look like they'd
--      already paid the carried-forward amount. This replaces that
--      with an RPC that raises the participant's target for the next
--      cycle instead — debt belongs in contributor_targets (what's
--      owed), not ledger_entries (what's moved).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Lock confirmed/disputed/resolved ledger entries at the DB level.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_ledger_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status NOT IN ('confirmed', 'disputed', 'resolved') THEN
    RETURN NEW; -- pending / proof_uploaded entries remain freely editable
  END IF;

  -- Once locked, `status` may only move through a whitelisted
  -- transition. Extend this list if a future 'reversed' flow is built.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'confirmed' AND NEW.status = 'disputed') OR
      (OLD.status = 'disputed'  AND NEW.status = 'resolved')
    ) THEN
      RAISE EXCEPTION 'ledger_entries: % -> % is not an allowed status transition for entry % (currently %)',
        OLD.status, NEW.status, OLD.id, OLD.status;
    END IF;
  END IF;

  -- Every other column is frozen once confirmed. `proofs` is excluded:
  -- admins/contributors can still attach or remove proof files on a
  -- confirmed entry (ledger.service.js#confirmProof / #deleteProof).
  -- `status` is handled above.
  IF (to_jsonb(NEW) - 'status' - 'proofs') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'proofs') THEN
    RAISE EXCEPTION 'ledger_entries: entry % is locked (status=%) — only its status (via an allowed transition) and proofs may change. Use a correction (corrects_entry_id) to adjust a confirmed entry instead.',
      OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_lock_confirmed ON public.ledger_entries;
CREATE TRIGGER trg_ledger_entries_lock_confirmed
  BEFORE UPDATE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ledger_entry_immutability();


CREATE OR REPLACE FUNCTION public.prevent_locked_ledger_entry_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('confirmed', 'disputed', 'resolved') THEN
    RAISE EXCEPTION 'ledger_entries: entry % cannot be deleted once confirmed (status=%). Use a correction instead.',
      OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_prevent_locked_delete ON public.ledger_entries;
CREATE TRIGGER trg_ledger_entries_prevent_locked_delete
  BEFORE DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_ledger_entry_delete();


-- ---------------------------------------------------------------------
-- 2. Carry-forward as debt: raise the next cycle's target instead of
--    faking a payment.
--
-- `cycle_carry_forwards` is both the audit trail (how much was carried,
-- from where, into what) and the idempotency guarantee: the unique
-- constraint on (container_participant_id, from_cycle_id) means a
-- lifecycle job re-run can never double-apply the same debt, replacing
-- the old note-text-matching check in application code — which was
-- itself a non-atomic check-then-act, the same race class this
-- codebase already uses atomic RPCs to close elsewhere (ADR-0010).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cycle_carry_forwards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_id uuid NOT NULL,
    container_participant_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    from_cycle_id uuid NOT NULL,
    to_cycle_id uuid NOT NULL,
    amount numeric(15,2) NOT NULL,
    currency text NOT NULL,
    resulting_target_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cycle_carry_forwards_pkey PRIMARY KEY (id),
    CONSTRAINT cycle_carry_forwards_amount_positive CHECK (amount > 0),
    CONSTRAINT cycle_carry_forwards_container_id_fkey FOREIGN KEY (container_id)
        REFERENCES public.containers(id),
    CONSTRAINT cycle_carry_forwards_participant_id_fkey FOREIGN KEY (container_participant_id)
        REFERENCES public.container_participants(id) ON DELETE CASCADE,
    CONSTRAINT cycle_carry_forwards_member_id_fkey FOREIGN KEY (workspace_member_id)
        REFERENCES public.workspace_members(id),
    CONSTRAINT cycle_carry_forwards_from_cycle_fkey FOREIGN KEY (from_cycle_id)
        REFERENCES public.container_cycles(id),
    CONSTRAINT cycle_carry_forwards_to_cycle_fkey FOREIGN KEY (to_cycle_id)
        REFERENCES public.container_cycles(id),
    CONSTRAINT cycle_carry_forwards_target_fkey FOREIGN KEY (resulting_target_id)
        REFERENCES public.contributor_targets(id),
    -- One carry-forward per participant per source cycle, ever.
    CONSTRAINT cycle_carry_forwards_unique_source UNIQUE (container_participant_id, from_cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_carry_forwards_to_cycle ON public.cycle_carry_forwards USING btree (to_cycle_id);


-- Supersedes (not mutates) the participant's current target for the
-- destination cycle, same pattern as set_contributor_target_atomic.
-- Idempotent: a second call for the same (participant, from_cycle) is
-- a guaranteed no-op via the cycle_carry_forwards unique constraint.
CREATE OR REPLACE FUNCTION public.apply_cycle_carry_forward_atomic(
    p_container_participant_id uuid,
    p_container_id uuid,
    p_workspace_member_id uuid,
    p_from_cycle_id uuid,
    p_to_cycle_id uuid,
    p_amount numeric,
    p_currency text,
    p_due_date date,
    p_set_by uuid
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_carry_id   uuid;
    v_previous   public.contributor_targets;
    v_new        public.contributor_targets;
    v_new_amount numeric;
BEGIN
    INSERT INTO public.cycle_carry_forwards (
        container_id, container_participant_id, workspace_member_id,
        from_cycle_id, to_cycle_id, amount, currency
    )
    VALUES (
        p_container_id, p_container_participant_id, p_workspace_member_id,
        p_from_cycle_id, p_to_cycle_id, p_amount, p_currency
    )
    ON CONFLICT (container_participant_id, from_cycle_id) DO NOTHING
    RETURNING id INTO v_carry_id;

    IF v_carry_id IS NULL THEN
        RETURN jsonb_build_object('applied', false, 'reason', 'already_applied');
    END IF;

    SELECT * INTO v_previous
    FROM public.contributor_targets
    WHERE container_participant_id = p_container_participant_id
      AND cycle_id = p_to_cycle_id
      AND is_current = true
    FOR UPDATE;

    IF v_previous.id IS NOT NULL THEN
        IF v_previous.target_currency IS DISTINCT FROM p_currency THEN
            RAISE EXCEPTION 'Cannot carry forward a % debt into a % target for participant % — cross-currency carry-forward is not supported',
                p_currency, v_previous.target_currency, p_container_participant_id;
        END IF;

        v_new_amount := v_previous.target_amount + p_amount;

        UPDATE public.contributor_targets
        SET is_current    = false,
            superseded_at = now()
        WHERE id = v_previous.id;
    ELSE
        v_new_amount := p_amount;
    END IF;

    INSERT INTO public.contributor_targets (
        container_participant_id, container_id, workspace_member_id,
        cycle_id, target_amount, target_currency, due_date,
        is_current, set_by
    )
    VALUES (
        p_container_participant_id, p_container_id, p_workspace_member_id,
        p_to_cycle_id, v_new_amount, p_currency, p_due_date,
        true, p_set_by
    )
    RETURNING * INTO v_new;

    IF v_previous.id IS NOT NULL THEN
        UPDATE public.contributor_targets SET superseded_by = v_new.id WHERE id = v_previous.id;
    END IF;

    UPDATE public.cycle_carry_forwards SET resulting_target_id = v_new.id WHERE id = v_carry_id;

    RETURN jsonb_build_object(
        'applied',        true,
        'carried_amount', p_amount,
        'new_target',     to_jsonb(v_new)
    );
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to apply cycle carry-forward: %', SQLERRM;
END;
$$;
