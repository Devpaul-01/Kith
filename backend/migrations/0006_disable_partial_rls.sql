-- 0006_disable_partial_rls.sql
--
-- Fixes audit finding 4.4: RLS was enabled + a single SELECT policy
-- defined on only 4 of ~20 tables (containers, ledger_entries,
-- milestones, notifications). The application exclusively uses
-- supabaseAdmin (the service-role client), which bypasses RLS entirely —
-- so these policies were never actually enforced by anything, but made
-- the schema read as if RLS were a load-bearing part of the security
-- model when it is not.
--
-- Per product decision: authorization is enforced entirely at the API
-- layer (requireMembership / requireAdmin / requireSelfOrAdmin in
-- src/middleware). RLS is intentionally not used. This migration disables
-- RLS and drops the now-misleading policies on the four affected tables.
--
-- Idempotent: safe to run multiple times.
--
-- If you later add a code path that queries Postgres directly with the
-- anon/RLS-respecting client (e.g. Supabase Realtime subscriptions from
-- the frontend), RLS will need to be reinstated deliberately and applied
-- consistently across every table that path can reach — not partially,
-- as it was here.

BEGIN;

DROP POLICY IF EXISTS members_select_containers    ON public.containers;
DROP POLICY IF EXISTS members_select_ledger         ON public.ledger_entries;
DROP POLICY IF EXISTS members_select_milestones     ON public.milestones;
DROP POLICY IF EXISTS members_select_notifications  ON public.notifications;

ALTER TABLE public.containers      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.milestones      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications   DISABLE ROW LEVEL SECURITY;

COMMIT;
