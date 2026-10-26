-- =====================================================================
-- Kith — Database Schema
-- A shared workspace for families/groups to coordinate money pooling,
-- recurring contributions, tasks, milestones, and notifications.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS public;

SET default_tablespace = '';
SET default_table_access_method = heap;

-- Generic trigger function: keeps `updated_at` current on row update.
-- Attached to every table below that has an `updated_at` column.
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Trigger function: blocks UPDATE/DELETE on audit_log to keep it append-only.
-- Attached to public.audit_log below.
CREATE FUNCTION public.audit_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

-- =====================================================================
-- CORE: users, workspaces, membership
-- =====================================================================

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text,
    bio text,
    country_of_residence text,
    timezone text DEFAULT 'UTC'::text,
    preferred_language text DEFAULT 'en'::text,
    avatar_url text,
    auth_provider text DEFAULT 'email'::text NOT NULL,
    push_token text,
    push_token_platform text,
    push_enabled boolean DEFAULT false NOT NULL,
    email_digest_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT users_auth_provider_check CHECK ((auth_provider = ANY (ARRAY['email'::text, 'google'::text, 'apple'::text]))),
    CONSTRAINT users_push_token_platform_check CHECK ((push_token_platform = ANY (ARRAY['web'::text, 'ios'::text, 'android'::text, NULL::text]))),
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.user_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    label text,
    value text NOT NULL,
    country_code text,
    is_primary boolean DEFAULT false NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_contacts_type_check CHECK ((type = ANY (ARRAY['email_secondary'::text, 'whatsapp'::text, 'phone'::text, 'telegram'::text, 'signal'::text, 'instagram'::text, 'facebook'::text, 'twitter'::text, 'linkedin'::text, 'custom'::text]))),
    CONSTRAINT user_contacts_pkey PRIMARY KEY (id),
    CONSTRAINT user_contacts_user_id_type_value_key UNIQUE (user_id, type, value),
    CONSTRAINT user_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_contacts_user ON public.user_contacts USING btree (user_id);

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    base_currency text DEFAULT 'GBP'::text NOT NULL,
    family_type text DEFAULT 'extended'::text NOT NULL,
    description text,
    avatar_url text,
    bank_details jsonb DEFAULT '{}'::jsonb,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workspaces_family_type_check CHECK ((family_type = ANY (ARRAY['nuclear'::text, 'extended'::text, 'blended'::text, 'community'::text, 'association'::text, 'other'::text]))),
    CONSTRAINT workspaces_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'public'::text]))),
    CONSTRAINT workspaces_pkey PRIMARY KEY (id),
    CONSTRAINT workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);

CREATE INDEX idx_workspaces_created_by ON public.workspaces USING btree (created_by);

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    role text DEFAULT 'member'::text NOT NULL,
    display_name text NOT NULL,
    relationship_to_head text,
    relationship_category text DEFAULT 'other'::text,
    date_of_birth date,
    is_proxy boolean DEFAULT false NOT NULL,
    proxy_managed_by uuid,
    admin_notes text,
    invite_status text,
    invited_at timestamp with time zone,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone,
    contribution_streak_months integer DEFAULT 0,
    last_contribution_date date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workspace_members_check CHECK ((((is_proxy = true) AND (user_id IS NULL)) OR (is_proxy = false))),
    CONSTRAINT workspace_members_check1 CHECK (((user_id IS NULL) OR (invite_status = 'accepted'::text) OR (invite_status IS NULL))),
    CONSTRAINT workspace_members_invite_status_check CHECK ((invite_status = ANY (ARRAY[NULL::text, 'pending'::text, 'accepted'::text, 'declined'::text]))),
    CONSTRAINT workspace_members_relationship_category_check CHECK ((relationship_category = ANY (ARRAY['blood'::text, 'marriage'::text, 'in_law'::text, 'friend'::text, 'other'::text]))),
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT workspace_members_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id),
    CONSTRAINT workspace_members_proxy_managed_by_fkey FOREIGN KEY (proxy_managed_by) REFERENCES public.workspace_members(id),
    CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_members_proxy ON public.workspace_members USING btree (workspace_id, is_proxy);

CREATE INDEX idx_workspace_members_role ON public.workspace_members USING btree (workspace_id, role);

CREATE INDEX idx_workspace_members_user ON public.workspace_members USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_workspace_members_workspace ON public.workspace_members USING btree (workspace_id) WHERE (deleted_at IS NULL);

CREATE TRIGGER workspace_members_updated_at BEFORE UPDATE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.workspace_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    setting_key text NOT NULL,
    setting_value jsonb,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_settings_pkey PRIMARY KEY (id),
    CONSTRAINT workspace_settings_workspace_id_setting_key_key UNIQUE (workspace_id, setting_key),
    CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES public.workspace_members(id) ON DELETE SET NULL,
    CONSTRAINT workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_settings_lookup ON public.workspace_settings USING btree (workspace_id, setting_key);

CREATE TRIGGER workspace_settings_updated_at BEFORE UPDATE ON public.workspace_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.invite_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    token text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    used_at timestamp with time zone,
    used_by_user_id uuid,
    CONSTRAINT invite_links_pkey PRIMARY KEY (id),
    CONSTRAINT invite_links_token_key UNIQUE (token),
    CONSTRAINT invite_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id),
    CONSTRAINT invite_links_used_by_user_id_fkey FOREIGN KEY (used_by_user_id) REFERENCES public.users(id),
    CONSTRAINT invite_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_invite_links_expiry ON public.invite_links USING btree (expires_at);

CREATE INDEX idx_invite_links_workspace ON public.invite_links USING btree (workspace_id);

CREATE UNIQUE INDEX idx_invite_links_token ON public.invite_links USING btree (token);

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT groups_pkey PRIMARY KEY (id),
    CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id),
    CONSTRAINT groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_groups_workspace ON public.groups USING btree (workspace_id);

CREATE TABLE public.group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid,
    CONSTRAINT group_members_pkey PRIMARY KEY (id),
    CONSTRAINT group_members_group_id_workspace_member_id_key UNIQUE (group_id, workspace_member_id),
    CONSTRAINT group_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.workspace_members(id),
    CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE,
    CONSTRAINT group_members_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE
);

CREATE INDEX idx_group_members_group ON public.group_members USING btree (group_id);

CREATE INDEX idx_group_members_member ON public.group_members USING btree (workspace_member_id);

-- =====================================================================
-- MONEY POOLS: containers, cycles, participants, targets
-- =====================================================================

CREATE TABLE public.containers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    subtitle text,
    description text,
    cover_photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    container_type text NOT NULL,
    enable_money boolean DEFAULT false NOT NULL,
    enable_tasks boolean DEFAULT false NOT NULL,
    event_date date,
    event_type text,
    event_type_category text DEFAULT 'other'::text,
    recurrence_cadence text,
    recurrence_days integer,
    recurrence_start date,
    recurrence_end date,
    carry_forward_unpaid boolean DEFAULT false NOT NULL,
    auto_generate_cycles boolean DEFAULT true NOT NULL,
    budget_target numeric(15,2),
    budget_currency text,
    public_token text,
    public_show_names boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    outcome_details text,
    outcome_files jsonb DEFAULT '[]'::jsonb NOT NULL,
    converted_from_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT containers_container_type_check CHECK ((container_type = ANY (ARRAY['event'::text, 'recurring'::text]))),
    CONSTRAINT containers_event_type_category_check CHECK ((event_type_category = ANY (ARRAY['celebration'::text, 'memorial'::text, 'financial'::text, 'logistical'::text, 'other'::text]))),
    CONSTRAINT containers_recurrence_cadence_check CHECK ((recurrence_cadence = ANY (ARRAY['monthly'::text, 'weekly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text, NULL::text]))),
    CONSTRAINT containers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'archived'::text, 'cancelled'::text]))),
    CONSTRAINT containers_pkey PRIMARY KEY (id),
    CONSTRAINT containers_public_token_key UNIQUE (public_token),
    CONSTRAINT containers_converted_from_id_fkey FOREIGN KEY (converted_from_id) REFERENCES public.containers(id),
    CONSTRAINT containers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id),
    CONSTRAINT containers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_containers_public_token ON public.containers USING btree (public_token) WHERE (public_token IS NOT NULL);

CREATE INDEX idx_containers_type ON public.containers USING btree (workspace_id, container_type) WHERE (deleted_at IS NULL);

CREATE INDEX idx_containers_workspace ON public.containers USING btree (workspace_id, status) WHERE (deleted_at IS NULL);

CREATE TRIGGER containers_updated_at BEFORE UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.container_cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_id uuid NOT NULL,
    cycle_number integer NOT NULL,
    cycle_start date NOT NULL,
    cycle_end date NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    total_expected numeric(15,2),
    total_collected numeric(15,2) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT container_cycles_status_check CHECK ((status = ANY (ARRAY['upcoming'::text, 'open'::text, 'closed'::text, 'skipped'::text]))),
    CONSTRAINT container_cycles_pkey PRIMARY KEY (id),
    CONSTRAINT container_cycles_container_id_cycle_number_key UNIQUE (container_id, cycle_number),
    CONSTRAINT container_cycles_container_id_cycle_start_key UNIQUE (container_id, cycle_start),
    CONSTRAINT container_cycles_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE
);

CREATE INDEX idx_cycles_container ON public.container_cycles USING btree (container_id, status);

CREATE INDEX idx_cycles_dates ON public.container_cycles USING btree (cycle_start, cycle_end);

CREATE TABLE public.container_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    role text,
    money_enabled boolean DEFAULT false NOT NULL,
    tasks_enabled boolean DEFAULT false NOT NULL,
    notes text,
    exclude_from_public boolean DEFAULT false NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid,
    CONSTRAINT container_participants_pkey PRIMARY KEY (id),
    CONSTRAINT container_participants_container_id_workspace_member_id_key UNIQUE (container_id, workspace_member_id),
    CONSTRAINT container_participants_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.workspace_members(id),
    CONSTRAINT container_participants_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE,
    CONSTRAINT container_participants_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id)
);

CREATE INDEX idx_participants_container ON public.container_participants USING btree (container_id);

CREATE INDEX idx_participants_member ON public.container_participants USING btree (workspace_member_id);

CREATE TABLE public.contributor_targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_participant_id uuid NOT NULL,
    container_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    cycle_id uuid,
    target_amount numeric(15,2) NOT NULL,
    target_currency text NOT NULL,
    due_date date,
    is_current boolean DEFAULT true NOT NULL,
    superseded_by uuid,
    superseded_at timestamp with time zone,
    set_by uuid NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contributor_targets_pkey PRIMARY KEY (id),
    CONSTRAINT contributor_targets_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id),
    CONSTRAINT contributor_targets_container_participant_id_fkey FOREIGN KEY (container_participant_id) REFERENCES public.container_participants(id) ON DELETE CASCADE,
    CONSTRAINT contributor_targets_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.container_cycles(id),
    CONSTRAINT contributor_targets_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.workspace_members(id),
    CONSTRAINT contributor_targets_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.contributor_targets(id),
    CONSTRAINT contributor_targets_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id)
);

CREATE INDEX idx_targets_container ON public.contributor_targets USING btree (container_id);

CREATE INDEX idx_targets_member ON public.contributor_targets USING btree (workspace_member_id);

CREATE INDEX idx_targets_set_at ON public.contributor_targets USING btree (container_participant_id, set_at DESC);

CREATE INDEX idx_targets_superseded_by ON public.contributor_targets USING btree (superseded_by) WHERE (superseded_by IS NOT NULL);

CREATE UNIQUE INDEX idx_targets_current_cycle ON public.contributor_targets USING btree (container_participant_id, cycle_id) WHERE ((is_current = true) AND (cycle_id IS NOT NULL));

CREATE UNIQUE INDEX idx_targets_current_event ON public.contributor_targets USING btree (container_participant_id) WHERE ((is_current = true) AND (cycle_id IS NULL));

-- Backs cycle_lifecycle.service.js#carryForwardUnpaid via
-- apply_cycle_carry_forward_atomic (defined further below, alongside
-- the other atomic RPCs). Is both the audit trail (how much was
-- carried, from where, into what) and the idempotency guarantee: the
-- unique constraint below means a lifecycle job re-run can never
-- double-apply the same debt.
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
    -- One carry-forward per participant per source cycle, ever — this
    -- is the idempotency guarantee carryForwardUnpaid() relies on.
    CONSTRAINT cycle_carry_forwards_unique_source UNIQUE (container_participant_id, from_cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_carry_forwards_to_cycle ON public.cycle_carry_forwards USING btree (to_cycle_id);

CREATE TABLE public.pool_cycle_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_id uuid NOT NULL,
    cycle_start date NOT NULL,
    override_type text NOT NULL,
    member_id uuid,
    new_target numeric(15,2),
    new_currency text,
    reason text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pool_cycle_overrides_override_type_check CHECK ((override_type = ANY (ARRAY['pause_pool'::text, 'skip_member'::text, 'adjust_target'::text]))),
    CONSTRAINT pool_cycle_overrides_pkey PRIMARY KEY (id),
    CONSTRAINT pool_cycle_overrides_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE,
    CONSTRAINT pool_cycle_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id),
    CONSTRAINT pool_cycle_overrides_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.workspace_members(id)
);

CREATE INDEX idx_overrides_container ON public.pool_cycle_overrides USING btree (container_id);

-- =====================================================================
-- TASKS & MILESTONES
-- =====================================================================

CREATE TABLE public.container_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    container_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    assigned_to uuid,
    due_date date,
    status text DEFAULT 'pending'::text NOT NULL,
    completed_at timestamp with time zone,
    completed_by uuid,
    completion_note text,
    proofs jsonb DEFAULT '[]'::jsonb NOT NULL,
    sort_order integer DEFAULT 0,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    admin_confirmed_at timestamp with time zone,
    admin_confirmed_by uuid,
    admin_note text,
    CONSTRAINT container_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'overdue'::text, 'cancelled'::text]))),
    CONSTRAINT container_tasks_pkey PRIMARY KEY (id),
    CONSTRAINT container_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.workspace_members(id),
    CONSTRAINT container_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.workspace_members(id),
    CONSTRAINT container_tasks_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE,
    CONSTRAINT container_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id)
);

CREATE INDEX idx_tasks_assigned ON public.container_tasks USING btree (assigned_to) WHERE (deleted_at IS NULL);

CREATE INDEX idx_tasks_container ON public.container_tasks USING btree (container_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_tasks_status ON public.container_tasks USING btree (container_id, status) WHERE (deleted_at IS NULL);

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.container_tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.milestones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    title text NOT NULL,
    milestone_date date NOT NULL,
    description text,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    milestone_type text DEFAULT 'custom'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT milestones_milestone_type_check CHECK ((milestone_type = ANY (ARRAY['birth'::text, 'graduation'::text, 'wedding'::text, 'death'::text, 'migration'::text, 'achievement'::text, 'custom'::text]))),
    CONSTRAINT milestones_pkey PRIMARY KEY (id),
    CONSTRAINT milestones_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id),
    CONSTRAINT milestones_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_milestones_workspace ON public.milestones USING btree (workspace_id, milestone_date DESC) WHERE (deleted_at IS NULL);

CREATE TRIGGER milestones_updated_at BEFORE UPDATE ON public.milestones FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =====================================================================
-- LEDGER & DISPUTES
-- =====================================================================

CREATE TABLE public.ledger_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    container_id uuid NOT NULL,
    cycle_id uuid,
    entry_type text NOT NULL,
    contributor_id uuid,
    original_amount numeric(15,2) NOT NULL,
    original_currency text NOT NULL,
    is_crypto boolean DEFAULT false NOT NULL,
    base_amount numeric(15,2) NOT NULL,
    payment_method text,
    proofs jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    corrects_entry_id uuid,
    note text,
    recorded_by uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    idempotency_key text,
    CONSTRAINT ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['contribution'::text, 'expense'::text, 'correction'::text, 'reversal'::text, 'carry_forward'::text]))),
    CONSTRAINT ledger_entries_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'mobile_money'::text, 'crypto'::text, 'other'::text, NULL::text]))),
    CONSTRAINT ledger_entries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'proof_uploaded'::text, 'confirmed'::text, 'disputed'::text, 'resolved'::text, 'reversed'::text]))),
    CONSTRAINT ledger_entries_pkey PRIMARY KEY (id),
    CONSTRAINT ledger_entries_idempotency_key_key UNIQUE (idempotency_key),
    CONSTRAINT ledger_entries_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.workspace_members(id),
    CONSTRAINT ledger_entries_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id),
    CONSTRAINT ledger_entries_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES public.workspace_members(id),
    CONSTRAINT ledger_entries_corrects_entry_id_fkey FOREIGN KEY (corrects_entry_id) REFERENCES public.ledger_entries(id),
    CONSTRAINT ledger_entries_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.container_cycles(id),
    CONSTRAINT ledger_entries_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.workspace_members(id),
    CONSTRAINT ledger_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)
);

CREATE INDEX idx_ledger_contributor ON public.ledger_entries USING btree (contributor_id);

CREATE INDEX idx_ledger_corrects_entry ON public.ledger_entries USING btree (corrects_entry_id) WHERE (corrects_entry_id IS NOT NULL);

CREATE INDEX idx_ledger_cycle ON public.ledger_entries USING btree (cycle_id) WHERE (cycle_id IS NOT NULL);

CREATE INDEX idx_ledger_recorded_at ON public.ledger_entries USING btree (recorded_at DESC);

CREATE INDEX idx_ledger_status ON public.ledger_entries USING btree (status);

CREATE INDEX idx_ledger_workspace_container ON public.ledger_entries USING btree (workspace_id, container_id);

-- Lock confirmed/disputed/resolved ledger entries at the DB level.
-- ledger.service.js already refuses to touch an entry once it leaves
-- 'pending'/'proof_uploaded' (updateEntry/deleteEntry) — this adds the
-- same rule as a trigger, so it holds even for anything with the
-- service-role key, not just requests that go through the app layer.
CREATE OR REPLACE FUNCTION public.enforce_ledger_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status NOT IN ('confirmed', 'disputed', 'resolved') THEN
    RETURN NEW; -- pending / proof_uploaded entries remain freely editable
  END IF;

  -- Once locked, `status` may only move through a whitelisted
  -- transition, matching what raise_dispute_atomic and
  -- resolve_dispute_atomic actually do. A pending -> disputed move
  -- never reaches this branch: it's covered by the early RETURN NEW
  -- above, since OLD.status = 'pending' isn't in the locked list.
  -- Extend this list if a future 'reversed' flow is built.
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
  -- ledger.service.js confirmProof/deleteProof both write to `proofs`
  -- on a possibly-locked entry (deleteProof lets an admin remove a
  -- proof from a confirmed entry). `status` is handled above.
  IF (to_jsonb(NEW) - 'status' - 'proofs') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'proofs') THEN
    RAISE EXCEPTION 'ledger_entries: entry % is locked (status=%) — only its status (via an allowed transition) and proofs may change. Use a correction (corrects_entry_id) to adjust a confirmed entry instead.',
      OLD.id, OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ledger_entries_lock_confirmed BEFORE UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.enforce_ledger_entry_immutability();

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

CREATE TRIGGER trg_ledger_entries_prevent_locked_delete BEFORE DELETE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.prevent_locked_ledger_entry_delete();

CREATE TABLE public.disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    ledger_entry_id uuid NOT NULL,
    raised_by uuid NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolution_note text,
    resolved_by uuid,
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    notes jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT disputes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text]))),
    CONSTRAINT disputes_pkey PRIMARY KEY (id),
    CONSTRAINT disputes_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id),
    CONSTRAINT disputes_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.workspace_members(id),
    CONSTRAINT disputes_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.workspace_members(id),
    CONSTRAINT disputes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)
);

CREATE INDEX idx_disputes_entry ON public.disputes USING btree (ledger_entry_id);

CREATE INDEX idx_disputes_workspace ON public.disputes USING btree (workspace_id, status);

CREATE UNIQUE INDEX idx_disputes_one_open_per_entry ON public.disputes USING btree (ledger_entry_id) WHERE (status = 'open'::text);

-- =====================================================================
-- NOTIFICATIONS
-- =====================================================================

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    recipient_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    reference_type text,
    reference_id uuid,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dedup_key text,
    CONSTRAINT notifications_reference_type_check CHECK ((reference_type = ANY (ARRAY['container'::text, 'ledger_entry'::text, 'dispute'::text, 'task'::text, 'milestone'::text, 'member'::text, NULL::text]))),
    CONSTRAINT notifications_pkey PRIMARY KEY (id),
    CONSTRAINT notifications_dedup_key_key UNIQUE (dedup_key),
    CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE,
    CONSTRAINT notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_recipient ON public.notifications USING btree (recipient_id, is_read);

CREATE INDEX idx_notifications_workspace ON public.notifications USING btree (workspace_id, created_at DESC);

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    delivered_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_deliveries_channel_check CHECK ((channel = ANY (ARRAY['in_app'::text, 'push'::text, 'email'::text]))),
    CONSTRAINT notification_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id),
    CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE
);

CREATE INDEX idx_notification_deliveries_status ON public.notification_deliveries USING btree (status, retry_count) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

-- =====================================================================
-- AUDIT & PROXY MANAGEMENT
-- =====================================================================

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    actor_user_id uuid,
    actor_member_id uuid,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    metadata jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_pkey PRIMARY KEY (id),
    CONSTRAINT audit_log_actor_member_id_fkey FOREIGN KEY (actor_member_id) REFERENCES public.workspace_members(id),
    CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id),
    CONSTRAINT audit_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)
);

CREATE INDEX idx_audit_actor ON public.audit_log USING btree (actor_user_id, created_at DESC);

CREATE INDEX idx_audit_workspace ON public.audit_log USING btree (workspace_id, created_at DESC);

CREATE TRIGGER audit_log_no_update_delete BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();

CREATE TABLE public.member_profile_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_member_id uuid NOT NULL,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    change_source text NOT NULL,
    CONSTRAINT member_profile_audit_change_source_check CHECK ((change_source = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT member_profile_audit_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.workspace_members(id),
    CONSTRAINT member_profile_audit_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE
);

CREATE INDEX idx_profile_audit_member ON public.member_profile_audit USING btree (workspace_member_id);

CREATE INDEX idx_profile_audit_time ON public.member_profile_audit USING btree (changed_at DESC);

CREATE TABLE public.proxy_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    proxy_member_id uuid NOT NULL,
    managed_by_id uuid NOT NULL,
    action_type text NOT NULL,
    target_id uuid,
    action_details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proxy_actions_pkey PRIMARY KEY (id),
    CONSTRAINT proxy_actions_managed_by_id_fkey FOREIGN KEY (managed_by_id) REFERENCES public.workspace_members(id),
    CONSTRAINT proxy_actions_proxy_member_id_fkey FOREIGN KEY (proxy_member_id) REFERENCES public.workspace_members(id),
    CONSTRAINT proxy_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id)
);

CREATE INDEX idx_proxy_actions_manager ON public.proxy_actions USING btree (managed_by_id);

CREATE INDEX idx_proxy_actions_proxy ON public.proxy_actions USING btree (proxy_member_id);

-- =====================================================================
-- FUNCTIONS: atomic/transactional operations used by the application
-- (update_updated_at_column() is defined near the top, since it's
-- attached to nearly every table)
-- =====================================================================

CREATE FUNCTION public.create_workspace_with_admin(p_name text, p_base_currency text, p_family_type text, p_description text, p_user_id uuid) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
            DECLARE
              v_workspace_id UUID;
                v_user_full_name TEXT;
                  v_result JSON;
                  BEGIN
                    -- Get user's full name
                      SELECT COALESCE(full_name, 'Admin') INTO v_user_full_name
                        FROM users
                          WHERE id = p_user_id;

                            -- Step 1: Create workspace
                              INSERT INTO workspaces (
                                  name,
                                      base_currency,
                                          family_type,
                                              description,
                                                  created_by
                                                    )
                                                      VALUES (
                                                          p_name,
                                                              p_base_currency,
                                                                  p_family_type,
                                                                      p_description,
                                                                          p_user_id
                                                                            )
                                                                              RETURNING id INTO v_workspace_id;

                                                                                -- Step 2: Add creator as admin member
                                                                                  INSERT INTO workspace_members (
                                                                                      workspace_id,
                                                                                          user_id,
                                                                                              role,
                                                                                                  display_name,
                                                                                                      invite_status
                                                                                                        )
                                                                                                          VALUES (
                                                                                                              v_workspace_id,
                                                                                                                  p_user_id,
                                                                                                                      'admin',
                                                                                                                          v_user_full_name,
                                                                                                                              'accepted'
                                                                                                                                );

                                                                                                                                  -- Step 3: Seed default settings
                                                                                                                                    INSERT INTO workspace_settings (
                                                                                                                                        workspace_id,
                                                                                                                                            setting_key,
                                                                                                                                                setting_value
                                                                                                                                                  )
                                                                                                                                                    VALUES 
                                                                                                                                                      (
                                                                                                                                                          v_workspace_id,
                                                                                                                                                              'notification_prefs',
                                                                                                                                                                  jsonb_build_object(
                                                                                                                                                                        'reminder_days_before', ARRAY[3, 1],
                                                                                                                                                                              'overdue_notify_after_days', ARRAY[3, 7],
                                                                                                                                                                                    'weekly_digest_enabled', true
                                                                                                                                                                                        )
                                                                                                                                                                                          ),
                                                                                                                                                                                            (
                                                                                                                                                                                                v_workspace_id,
                                                                                                                                                                                                    'reminder_templates',
                                                                                                                                                                                                        jsonb_build_object(
                                                                                                                                                                                                              'due_soon', 'Hi {name}, just a reminder about your contribution for {event_name}: {target_amount} {currency} due {due_date}.',
                                                                                                                                                                                                                    'overdue', 'Hi {name}, your contribution for {event_name} is now overdue.'
                                                                                                                                                                                                                        )
                                                                                                                                                                                                                          ),
                                                                                                                                                                                                                            (
                                                                                                                                                                                                                                v_workspace_id,
                                                                                                                                                                                                                                    'invite_message',
                                                                                                                                                                                                                                        jsonb_build_object(
                                                                                                                                                                                                                                              'template', 'Join our family on Kith: {invite_link}'
                                                                                                                                                                                                                                                  )
                                                                                                                                                                                                                                                    );

                                                                                                                                                                                                                                                      -- Step 4: Return the created workspace and member info
                                                                                                                                                                                                                                                        SELECT jsonb_build_object(
                                                                                                                                                                                                                                                            'workspace', row_to_json(w),
                                                                                                                                                                                                                                                                'member', row_to_json(m)
                                                                                                                                                                                                                                                                  )
                                                                                                                                                                                                                                                                    INTO v_result
                                                                                                                                                                                                                                                                      FROM workspaces w
                                                                                                                                                                                                                                                                        CROSS JOIN workspace_members m
                                                                                                                                                                                                                                                                          WHERE w.id = v_workspace_id 
                                                                                                                                                                                                                                                                              AND m.workspace_id = v_workspace_id 
                                                                                                                                                                                                                                                                                  AND m.user_id = p_user_id;

                                                                                                                                                                                                                                                                                    RETURN v_result;
                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                      EXCEPTION
                                                                                                                                                                                                                                                                                        WHEN OTHERS THEN
                                                                                                                                                                                                                                                                                            -- Any error rolls back the entire transaction automatically
                                                                                                                                                                                                                                                                                                RAISE EXCEPTION 'Failed to create workspace: %', SQLERRM;
                                                                                                                                                                                                                                                                                                END;
                                                                                                                                                                                                                                                                                                $$;

CREATE FUNCTION public.convert_event_to_recurring_atomic(p_source_container_id uuid, p_workspace_id uuid, p_new_name text, p_recurrence_cadence text, p_recurrence_days integer, p_recurrence_start date, p_recurrence_end date, p_carry_forward_unpaid boolean, p_created_by uuid) RETURNS jsonb
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

CREATE FUNCTION public.create_ledger_entry_checked(p_workspace_id uuid, p_container_id uuid, p_cycle_id uuid, p_entry_type text, p_contributor_id uuid, p_original_amount numeric, p_original_currency text, p_base_amount numeric, p_payment_method text, p_note text, p_is_crypto boolean, p_status text, p_recorded_by uuid, p_confirmed_at timestamp with time zone, p_confirmed_by uuid, p_dup_window interval, p_force boolean) RETURNS jsonb
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

CREATE FUNCTION public.set_contributor_target_atomic(p_container_participant_id uuid, p_container_id uuid, p_workspace_member_id uuid, p_target_amount numeric, p_target_currency text, p_due_date date, p_set_by uuid) RETURNS jsonb
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

-- Called by cycle_lifecycle.service.js#carryForwardUnpaid with exactly
-- these parameters. Supersedes (not mutates) the participant's current
-- target for the destination cycle, same pattern as
-- set_contributor_target_atomic above. Idempotent: a second call for
-- the same (participant, from_cycle) is a guaranteed no-op via the
-- cycle_carry_forwards unique constraint — carryForwardUnpaid() checks
-- the returned `applied` flag and skips its notification when false.
CREATE OR REPLACE FUNCTION public.apply_cycle_carry_forward_atomic(p_container_participant_id uuid, p_container_id uuid, p_workspace_member_id uuid, p_from_cycle_id uuid, p_to_cycle_id uuid, p_amount numeric, p_currency text, p_due_date date, p_set_by uuid) RETURNS jsonb
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

CREATE FUNCTION public.raise_dispute_atomic(p_workspace_id uuid, p_ledger_entry_id uuid, p_raised_by uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    DECLARE
      v_entry   public.ledger_entries;
        v_dispute public.disputes;
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

                                    UPDATE public.ledger_entries SET status = 'disputed' WHERE id = p_ledger_entry_id;

                                      RETURN to_jsonb(v_dispute);
                                      END;
                                      $$;

CREATE FUNCTION public.resolve_dispute_atomic(p_dispute_id uuid, p_resolution_note text, p_resolved_by uuid, p_resolved_at timestamp with time zone) RETURNS jsonb
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

CREATE FUNCTION public.replace_user_contacts_atomic(p_user_id uuid, p_types text[], p_contacts jsonb) RETURNS jsonb
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

CREATE FUNCTION public.upsert_primary_contact(p_user_id uuid, p_type text, p_value text, p_label text, p_country_code text, p_is_primary boolean) RETURNS jsonb
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

