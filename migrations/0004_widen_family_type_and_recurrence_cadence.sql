-- 0004_widen_family_type_and_recurrence_cadence.sql
--
-- Fixes audit findings 2.1 and 2.2: the application-layer Zod validators
-- (src/validators/workspace.validator.js) already accept a broader set of
-- values than the database CHECK constraints allow, so valid-looking
-- requests were failing with an unhandled 500 (23514 check violation)
-- instead of a clean validation error.
--
-- Direction chosen (per product decision): widen the DATABASE to match the
-- already-shipped backend/validator surface, rather than narrow the
-- validator. This is a non-breaking, additive change (existing rows and
-- existing valid values are untouched).
--
-- Idempotent: safe to run multiple times.

BEGIN;

-- ── workspaces.family_type ──────────────────────────────────────────
-- Backend validator (FAMILY_TYPES in workspace.validator.js) allows:
--   nuclear, extended, blended, community, association, other
-- Previous DB constraint only allowed: extended, event, pool
-- ('event' and 'pool' do not appear anywhere in the current backend
-- validator and are dropped from the allowed set below; if any existing
-- row uses them, the ALTER TABLE will fail loudly rather than silently
-- passing rows that no longer validate — see the guard below.)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workspaces
    WHERE family_type NOT IN ('nuclear','extended','blended','community','association','other')
  ) THEN
    RAISE EXCEPTION
      'Cannot widen workspaces_family_type_check: rows exist with family_type values (e.g. event/pool) outside the new allowed set. Resolve these rows manually before re-running this migration.';
  END IF;
END $$;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_family_type_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_family_type_check
  CHECK ((family_type = ANY (ARRAY['nuclear'::text, 'extended'::text, 'blended'::text, 'community'::text, 'association'::text, 'other'::text])));

-- ── containers.recurrence_cadence ───────────────────────────────────
-- Backend validator (createContainerSchema) already advertises 'weekly' as
-- a valid cadence to clients. The cycle-generation worker
-- (src/workers/background.workers.js) has been updated in this same
-- change set to actually generate weekly cycles. Widen the constraint to
-- match.

ALTER TABLE public.containers
  DROP CONSTRAINT IF EXISTS containers_recurrence_cadence_check;

ALTER TABLE public.containers
  ADD CONSTRAINT containers_recurrence_cadence_check
  CHECK ((recurrence_cadence = ANY (ARRAY['monthly'::text, 'weekly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text, NULL::text])));

COMMIT;
