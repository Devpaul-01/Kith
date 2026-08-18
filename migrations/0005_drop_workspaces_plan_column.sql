-- 0005_drop_workspaces_plan_column.sql
--
-- Fixes audit finding 4.1: workspace.controller.js and workspace.js
-- (requireMembership middleware) both explicitly state "plan is not a
-- column on the workspaces table" / "removed plan from workspace select"
-- — but schema.sql defines workspaces.plan + plan_expires_at +
-- idx_workspaces_plan. Per product decision, the column is confirmed
-- genuinely unused by the application and is being dropped so the schema
-- reflects reality.
--
-- Idempotent: safe to run multiple times (IF EXISTS guards).
--
-- NOTE: this is destructive (DROP COLUMN). Nothing in the reviewed
-- backend reads or writes workspaces.plan or workspaces.plan_expires_at,
-- but please confirm no other service/consumer (e.g. a billing
-- integration not included in this review) depends on it before running
-- this in production.

BEGIN;

DROP INDEX IF EXISTS public.idx_workspaces_plan;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_plan_check;

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS plan;

ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS plan_expires_at;

COMMIT;
