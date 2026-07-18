-- ============================================================
-- Kith Database Schema
-- Cleaned schema-only dump (tables, constraints, indexes,
-- triggers, foreign keys, and RLS policies).
-- Application logic functions (create_workspace_with_admin,
-- exec_sql) have been excluded — schema objects only.
-- Source: PostgreSQL 17.6 (pg_dump 18.2)
-- ============================================================

CREATE SCHEMA IF NOT EXISTS public;

COMMENT ON SCHEMA public IS 'standard public schema';

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

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
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

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
    CONSTRAINT container_cycles_status_check CHECK ((status = ANY (ARRAY['upcoming'::text, 'open'::text, 'closed'::text, 'skipped'::text])))
);

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
    added_by uuid
);

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
    CONSTRAINT container_tasks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'overdue'::text, 'cancelled'::text])))
);

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
    CONSTRAINT containers_recurrence_cadence_check CHECK ((recurrence_cadence = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text, NULL::text]))),
    CONSTRAINT containers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'archived'::text, 'cancelled'::text])))
);

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
    set_at timestamp with time zone DEFAULT now() NOT NULL
);

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
    CONSTRAINT disputes_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);

CREATE TABLE public.group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    workspace_member_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid
);

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.invite_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    token text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    used_at timestamp with time zone,
    used_by_user_id uuid
);

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
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    idempotency_key text,
    CONSTRAINT ledger_entries_entry_type_check CHECK ((entry_type = ANY (ARRAY['contribution'::text, 'expense'::text, 'correction'::text, 'reversal'::text, 'carry_forward'::text]))),
    CONSTRAINT ledger_entries_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'mobile_money'::text, 'crypto'::text, 'other'::text, NULL::text]))),
    CONSTRAINT ledger_entries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'proof_uploaded'::text, 'confirmed'::text, 'disputed'::text, 'resolved'::text, 'reversed'::text])))
);

CREATE TABLE public.member_profile_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_member_id uuid NOT NULL,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    change_source text NOT NULL,
    CONSTRAINT member_profile_audit_change_source_check CHECK ((change_source = ANY (ARRAY['admin'::text, 'member'::text])))
);

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
    CONSTRAINT milestones_milestone_type_check CHECK ((milestone_type = ANY (ARRAY['birth'::text, 'graduation'::text, 'wedding'::text, 'death'::text, 'migration'::text, 'achievement'::text, 'custom'::text])))
);

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
    CONSTRAINT notification_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'skipped'::text])))
);

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
    CONSTRAINT notifications_reference_type_check CHECK ((reference_type = ANY (ARRAY['container'::text, 'ledger_entry'::text, 'dispute'::text, 'task'::text, 'milestone'::text, 'member'::text, NULL::text])))
);

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
    CONSTRAINT pool_cycle_overrides_override_type_check CHECK ((override_type = ANY (ARRAY['pause_pool'::text, 'skip_member'::text, 'adjust_target'::text])))
);

CREATE TABLE public.proxy_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    proxy_member_id uuid NOT NULL,
    managed_by_id uuid NOT NULL,
    action_type text NOT NULL,
    target_id uuid,
    action_details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

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
    CONSTRAINT user_contacts_type_check CHECK ((type = ANY (ARRAY['email_secondary'::text, 'whatsapp'::text, 'phone'::text, 'telegram'::text, 'signal'::text, 'instagram'::text, 'facebook'::text, 'twitter'::text, 'linkedin'::text, 'custom'::text])))
);

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
    CONSTRAINT users_push_token_platform_check CHECK ((push_token_platform = ANY (ARRAY['web'::text, 'ios'::text, 'android'::text, NULL::text])))
);

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
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);

CREATE TABLE public.workspace_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    setting_key text NOT NULL,
    setting_value jsonb,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    base_currency text DEFAULT 'GBP'::text NOT NULL,
    family_type text DEFAULT 'extended'::text NOT NULL,
    description text,
    avatar_url text,
    bank_details jsonb DEFAULT '{}'::jsonb,
    plan text DEFAULT 'free'::text NOT NULL,
    plan_expires_at timestamp with time zone,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT workspaces_family_type_check CHECK ((family_type = ANY (ARRAY['extended'::text, 'event'::text, 'pool'::text]))),
    CONSTRAINT workspaces_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'core'::text, 'pro'::text]))),
    CONSTRAINT workspaces_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'public'::text])))
);
CREATE OR REPLACE FUNCTION public.create_workspace_with_admin(
    p_name text,
    p_base_currency text,
    p_family_type text,
    p_description text,
    p_user_id uuid
) RETURNS json
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
    VALUES (
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
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.container_cycles
    ADD CONSTRAINT container_cycles_container_id_cycle_number_key UNIQUE (container_id, cycle_number);

ALTER TABLE ONLY public.container_cycles
    ADD CONSTRAINT container_cycles_container_id_cycle_start_key UNIQUE (container_id, cycle_start);

ALTER TABLE ONLY public.container_cycles
    ADD CONSTRAINT container_cycles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.container_participants
    ADD CONSTRAINT container_participants_container_id_workspace_member_id_key UNIQUE (container_id, workspace_member_id);

ALTER TABLE ONLY public.container_participants
    ADD CONSTRAINT container_participants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.container_tasks
    ADD CONSTRAINT container_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_public_token_key UNIQUE (public_token);

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_workspace_member_id_key UNIQUE (group_id, workspace_member_id);

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_token_key UNIQUE (token);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.member_profile_audit
    ADD CONSTRAINT member_profile_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_dedup_key_key UNIQUE (dedup_key);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pool_cycle_overrides
    ADD CONSTRAINT pool_cycle_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.proxy_actions
    ADD CONSTRAINT proxy_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_contacts
    ADD CONSTRAINT user_contacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_contacts
    ADD CONSTRAINT user_contacts_user_id_type_value_key UNIQUE (user_id, type, value);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id);

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_workspace_id_setting_key_key UNIQUE (workspace_id, setting_key);

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

CREATE INDEX idx_audit_actor ON public.audit_log USING btree (actor_user_id, created_at DESC);

CREATE INDEX idx_audit_workspace ON public.audit_log USING btree (workspace_id, created_at DESC);

CREATE INDEX idx_containers_public_token ON public.containers USING btree (public_token) WHERE (public_token IS NOT NULL);

CREATE INDEX idx_containers_type ON public.containers USING btree (workspace_id, container_type) WHERE (deleted_at IS NULL);

CREATE INDEX idx_containers_workspace ON public.containers USING btree (workspace_id, status) WHERE (deleted_at IS NULL);

CREATE INDEX idx_cycles_container ON public.container_cycles USING btree (container_id, status);

CREATE INDEX idx_cycles_dates ON public.container_cycles USING btree (cycle_start, cycle_end);

CREATE INDEX idx_disputes_entry ON public.disputes USING btree (ledger_entry_id);

CREATE INDEX idx_disputes_workspace ON public.disputes USING btree (workspace_id, status);

CREATE INDEX idx_group_members_group ON public.group_members USING btree (group_id);

CREATE INDEX idx_group_members_member ON public.group_members USING btree (workspace_member_id);

CREATE INDEX idx_groups_workspace ON public.groups USING btree (workspace_id);

CREATE INDEX idx_invite_links_expiry ON public.invite_links USING btree (expires_at);

CREATE UNIQUE INDEX idx_invite_links_token ON public.invite_links USING btree (token);

CREATE INDEX idx_invite_links_workspace ON public.invite_links USING btree (workspace_id);

CREATE INDEX idx_ledger_contributor ON public.ledger_entries USING btree (contributor_id);

CREATE INDEX idx_ledger_cycle ON public.ledger_entries USING btree (cycle_id) WHERE (cycle_id IS NOT NULL);

CREATE INDEX idx_ledger_recorded_at ON public.ledger_entries USING btree (recorded_at DESC);

CREATE INDEX idx_ledger_status ON public.ledger_entries USING btree (status);

CREATE INDEX idx_ledger_workspace_container ON public.ledger_entries USING btree (workspace_id, container_id);

CREATE INDEX idx_milestones_workspace ON public.milestones USING btree (workspace_id, milestone_date DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_notification_deliveries_status ON public.notification_deliveries USING btree (status, retry_count) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

CREATE INDEX idx_notifications_recipient ON public.notifications USING btree (recipient_id, is_read);

CREATE INDEX idx_notifications_workspace ON public.notifications USING btree (workspace_id, created_at DESC);

CREATE INDEX idx_overrides_container ON public.pool_cycle_overrides USING btree (container_id);

CREATE INDEX idx_participants_container ON public.container_participants USING btree (container_id);

CREATE INDEX idx_participants_member ON public.container_participants USING btree (workspace_member_id);

CREATE INDEX idx_profile_audit_member ON public.member_profile_audit USING btree (workspace_member_id);

CREATE INDEX idx_profile_audit_time ON public.member_profile_audit USING btree (changed_at DESC);

CREATE INDEX idx_proxy_actions_manager ON public.proxy_actions USING btree (managed_by_id);

CREATE INDEX idx_proxy_actions_proxy ON public.proxy_actions USING btree (proxy_member_id);

CREATE INDEX idx_targets_container ON public.contributor_targets USING btree (container_id);

CREATE UNIQUE INDEX idx_targets_current_cycle ON public.contributor_targets USING btree (container_participant_id, cycle_id) WHERE ((is_current = true) AND (cycle_id IS NOT NULL));

CREATE UNIQUE INDEX idx_targets_current_event ON public.contributor_targets USING btree (container_participant_id) WHERE ((is_current = true) AND (cycle_id IS NULL));

CREATE INDEX idx_targets_member ON public.contributor_targets USING btree (workspace_member_id);

CREATE INDEX idx_tasks_assigned ON public.container_tasks USING btree (assigned_to) WHERE (deleted_at IS NULL);

CREATE INDEX idx_tasks_container ON public.container_tasks USING btree (container_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_tasks_status ON public.container_tasks USING btree (container_id, status) WHERE (deleted_at IS NULL);

CREATE INDEX idx_user_contacts_user ON public.user_contacts USING btree (user_id);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE INDEX idx_workspace_members_proxy ON public.workspace_members USING btree (workspace_id, is_proxy);

CREATE INDEX idx_workspace_members_role ON public.workspace_members USING btree (workspace_id, role);

CREATE INDEX idx_workspace_members_user ON public.workspace_members USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX idx_workspace_members_workspace ON public.workspace_members USING btree (workspace_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_workspace_settings_lookup ON public.workspace_settings USING btree (workspace_id, setting_key);

CREATE INDEX idx_workspaces_created_by ON public.workspaces USING btree (created_by);

CREATE INDEX idx_workspaces_plan ON public.workspaces USING btree (plan);

CREATE TRIGGER containers_updated_at BEFORE UPDATE ON public.containers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER milestones_updated_at BEFORE UPDATE ON public.milestones FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.container_tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER workspace_members_updated_at BEFORE UPDATE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER workspace_settings_updated_at BEFORE UPDATE ON public.workspace_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_member_id_fkey FOREIGN KEY (actor_member_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);

ALTER TABLE ONLY public.container_cycles
    ADD CONSTRAINT container_cycles_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.container_participants
    ADD CONSTRAINT container_participants_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.container_participants
    ADD CONSTRAINT container_participants_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.container_participants
    ADD CONSTRAINT container_participants_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.container_tasks
    ADD CONSTRAINT container_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.container_tasks
    ADD CONSTRAINT container_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.container_tasks
    ADD CONSTRAINT container_tasks_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.container_tasks
    ADD CONSTRAINT container_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_converted_from_id_fkey FOREIGN KEY (converted_from_id) REFERENCES public.containers(id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.containers
    ADD CONSTRAINT containers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id);

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_container_participant_id_fkey FOREIGN KEY (container_participant_id) REFERENCES public.container_participants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.container_cycles(id);

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.contributor_targets(id);

ALTER TABLE ONLY public.contributor_targets
    ADD CONSTRAINT contributor_targets_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_ledger_entry_id_fkey FOREIGN KEY (ledger_entry_id) REFERENCES public.ledger_entries(id);

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by) REFERENCES public.workspace_members(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_used_by_user_id_fkey FOREIGN KEY (used_by_user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.invite_links
    ADD CONSTRAINT invite_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_corrects_entry_id_fkey FOREIGN KEY (corrects_entry_id) REFERENCES public.ledger_entries(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.container_cycles(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);

ALTER TABLE ONLY public.member_profile_audit
    ADD CONSTRAINT member_profile_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.member_profile_audit
    ADD CONSTRAINT member_profile_audit_workspace_member_id_fkey FOREIGN KEY (workspace_member_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.workspace_members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pool_cycle_overrides
    ADD CONSTRAINT pool_cycle_overrides_container_id_fkey FOREIGN KEY (container_id) REFERENCES public.containers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pool_cycle_overrides
    ADD CONSTRAINT pool_cycle_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.pool_cycle_overrides
    ADD CONSTRAINT pool_cycle_overrides_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.proxy_actions
    ADD CONSTRAINT proxy_actions_managed_by_id_fkey FOREIGN KEY (managed_by_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.proxy_actions
    ADD CONSTRAINT proxy_actions_proxy_member_id_fkey FOREIGN KEY (proxy_member_id) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.proxy_actions
    ADD CONSTRAINT proxy_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);

ALTER TABLE ONLY public.user_contacts
    ADD CONSTRAINT user_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_proxy_managed_by_fkey FOREIGN KEY (proxy_managed_by) REFERENCES public.workspace_members(id);

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);

ALTER TABLE public.containers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY members_select_containers ON public.containers FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.is_active = true) AND (workspace_members.deleted_at IS NULL)))));

CREATE POLICY members_select_ledger ON public.ledger_entries FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.is_active = true) AND (workspace_members.deleted_at IS NULL)))));

CREATE POLICY members_select_milestones ON public.milestones FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.is_active = true) AND (workspace_members.deleted_at IS NULL)))));

CREATE POLICY members_select_notifications ON public.notifications FOR SELECT USING ((recipient_id IN ( SELECT workspace_members.id
   FROM public.workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.is_active = true) AND (workspace_members.deleted_at IS NULL)))));

ALTER TABLE public.milestones ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
