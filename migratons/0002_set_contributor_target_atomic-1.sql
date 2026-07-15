-- Migration: set_contributor_target_atomic
--
-- Issue H1 fix: participant.controller.js#setTarget previously performed
-- three sequential, non-transactional writes:
--   1. UPDATE existing current target SET is_current = false
--   2. INSERT new target
--   3. UPDATE existing target SET superseded_by = <new target id>
-- If step 2 failed after step 1 succeeded, the participant would be left
-- with NO current target at all — an orphaned state requiring manual
-- intervention. This RPC wraps all three steps in a single Postgres
-- transaction, consistent with raise_dispute_atomic / resolve_dispute_atomic
-- / convert_event_to_recurring_atomic already used elsewhere in this schema
-- for exactly this class of problem.
--
-- VERIFIED AGAINST LIVE SCHEMA (kith_schema.txt): contributor_targets'
-- columns match this migration's assumptions exactly. Critically, the
-- schema also revealed a partial unique index NOT visible from application
-- code alone:
--
--   CREATE UNIQUE INDEX idx_targets_current_event
--     ON contributor_targets (container_participant_id)
--     WHERE (is_current = true AND cycle_id IS NULL);
--
-- This means at most one "current, non-cycle" target can exist per
-- participant at any instant. An earlier draft of this migration inserted
-- the new row (is_current = true) BEFORE demoting the old one — that would
-- have hit a 23505 unique-violation on this index on every single call
-- where a target already existed, since both rows would briefly be
-- is_current = true simultaneously. Fixed by demoting the old row FIRST,
-- then inserting the new one.
--
-- Rollback: DROP FUNCTION IF EXISTS set_contributor_target_atomic(uuid, uuid, uuid, numeric, text, date, uuid);

CREATE OR REPLACE FUNCTION set_contributor_target_atomic(
  p_container_participant_id uuid,
  p_container_id             uuid,
  p_workspace_member_id      uuid,
  p_target_amount            numeric,
  p_target_currency          text,
  p_due_date                 date,
  p_set_by                   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing   contributor_targets%ROWTYPE;
  v_new_target contributor_targets%ROWTYPE;
BEGIN
  -- Lock any existing current (non-cycle) target for this participant so
  -- concurrent calls targeting the same participant serialize instead of
  -- racing each other.
  SELECT * INTO v_existing
  FROM contributor_targets
  WHERE container_participant_id = p_container_participant_id
    AND is_current = true
    AND cycle_id IS NULL
  FOR UPDATE;

  -- Demote the existing target FIRST — must happen before the insert
  -- below, or the two rows would briefly both satisfy
  -- idx_targets_current_event's partial-unique predicate and the insert
  -- would fail with a 23505 unique violation.
  IF v_existing.id IS NOT NULL THEN
    UPDATE contributor_targets
    SET is_current    = false,
        superseded_at = now()
    WHERE id = v_existing.id;
  END IF;

  INSERT INTO contributor_targets (
    container_participant_id, container_id, workspace_member_id,
    target_amount, target_currency, due_date, is_current, set_by, set_at
  ) VALUES (
    p_container_participant_id, p_container_id, p_workspace_member_id,
    p_target_amount, p_target_currency, p_due_date, true, p_set_by, now()
  )
  RETURNING * INTO v_new_target;

  IF v_existing.id IS NOT NULL THEN
    UPDATE contributor_targets
    SET superseded_by = v_new_target.id
    WHERE id = v_existing.id;

    -- Reflect both updates in the row we return to the caller, so the
    -- response doesn't require a second read.
    v_existing.is_current    := false;
    v_existing.superseded_by := v_new_target.id;
  END IF;

  RETURN jsonb_build_object(
    'new_target',      to_jsonb(v_new_target),
    'previous_target', CASE WHEN v_existing.id IS NULL THEN NULL ELSE to_jsonb(v_existing) END
  );
END;
$$;
