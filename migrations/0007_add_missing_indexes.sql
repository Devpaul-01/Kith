-- 0007_add_missing_indexes.sql
--
-- Fixes audit finding 4.3: a few frequently-joined/looked-up columns had
-- no supporting index.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS.

BEGIN;

-- Correction-chain lookups ("show me the correction history for this entry")
CREATE INDEX IF NOT EXISTS idx_ledger_corrects_entry
  ON public.ledger_entries USING btree (corrects_entry_id)
  WHERE corrects_entry_id IS NOT NULL;

-- Target-supersession-chain lookups (getTargetHistory walks these)
CREATE INDEX IF NOT EXISTS idx_targets_superseded_by
  ON public.contributor_targets USING btree (superseded_by)
  WHERE superseded_by IS NOT NULL;

-- Ordering used by getTargetHistory (.order('set_at', {ascending:false}))
CREATE INDEX IF NOT EXISTS idx_targets_set_at
  ON public.contributor_targets USING btree (container_participant_id, set_at DESC);

COMMIT;
