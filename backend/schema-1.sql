-- ================================================================
-- KITH — COMPLETE DATABASE SCHEMA
-- Version 2.1 | Phase 1
-- Run this against your Supabase project SQL editor (in order).
-- ================================================================

-- ── EXTENSIONS ───────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── HELPER FUNCTION ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ================================================================
-- IDENTITY CONTEXT
-- ================================================================

-- TABLE: users
CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY,  -- matches Supabase auth.users.id
  email                 TEXT NOT NULL UNIQUE,
  full_name             TEXT NOT NULL,
  bio                   TEXT,
  country_of_residence  TEXT,
  timezone              TEXT DEFAULT 'UTC',
  preferred_language    TEXT DEFAULT 'en',
  avatar_url            TEXT,

  push_token            TEXT,
  push_token_platform   TEXT CHECK (push_token_platform IN ('web','ios','android', NULL)),
  push_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  email_digest_enabled  BOOLEAN NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_users_email_verified ON users(email);

-- TABLE: user_contacts
CREATE TABLE IF NOT EXISTS user_contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN (
                  'email_secondary','whatsapp','phone','telegram',
                  'signal','instagram','facebook','twitter','linkedin','custom'
                )),
  label         TEXT,
  value         TEXT NOT NULL,
  country_code  TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, type, value)
);

CREATE INDEX idx_user_contacts_user ON user_contacts(user_id);

-- ================================================================
-- WORKSPACE CONTEXT
-- ================================================================

-- TABLE: workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  base_currency   TEXT NOT NULL DEFAULT 'GBP',
  family_type     TEXT NOT NULL DEFAULT 'extended'
                    CHECK (family_type IN ('extended','event','pool')),
  description     TEXT,
  avatar_url      TEXT,
  bank_details    JSONB DEFAULT '{}',
  plan            TEXT NOT NULL DEFAULT 'free'
                    CHECK (plan IN ('free','core','pro')),
  plan_expires_at TIMESTAMPTZ,
  visibility      TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private','public')),
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_workspaces_created_by ON workspaces(created_by);
CREATE INDEX idx_workspaces_plan ON workspaces(plan);

CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- TABLE: workspace_settings
CREATE TABLE IF NOT EXISTS workspace_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  setting_key   TEXT NOT NULL,
  setting_value JSONB,
  updated_by    UUID,  -- references workspace_members.id (added after that table exists)
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, setting_key)
);

CREATE INDEX idx_workspace_settings_lookup ON workspace_settings(workspace_id, setting_key);

-- TABLE: workspace_members
CREATE TABLE IF NOT EXISTS workspace_members (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                     UUID REFERENCES users(id) ON DELETE SET NULL,
  role                        TEXT NOT NULL DEFAULT 'member'
                                CHECK (role IN ('admin','member')),
  display_name                TEXT NOT NULL,
  relationship_to_head        TEXT,
  relationship_category       TEXT DEFAULT 'other'
                                CHECK (relationship_category IN (
                                  'blood','marriage','in_law','friend','other'
                                )),
  date_of_birth               DATE,
  is_proxy                    BOOLEAN NOT NULL DEFAULT FALSE,
  proxy_managed_by            UUID REFERENCES workspace_members(id),
  admin_notes                 TEXT,
  invite_status               TEXT CHECK (invite_status IN (NULL,'pending','accepted','declined')),
  invited_at                  TIMESTAMPTZ,
  joined_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at              TIMESTAMPTZ,
  contribution_streak_months  INTEGER DEFAULT 0,
  last_contribution_date      DATE,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                  TIMESTAMPTZ,

  UNIQUE(workspace_id, user_id),

  CHECK (
    (is_proxy = TRUE AND user_id IS NULL)
    OR (is_proxy = FALSE)
  ),
  CHECK (
    user_id IS NULL
    OR invite_status = 'accepted'
    OR invite_status IS NULL
  )
);

CREATE INDEX idx_workspace_members_workspace
  ON workspace_members(workspace_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_workspace_members_user
  ON workspace_members(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_workspace_members_proxy
  ON workspace_members(workspace_id, is_proxy);
CREATE INDEX idx_workspace_members_role
  ON workspace_members(workspace_id, role);

CREATE TRIGGER workspace_members_updated_at BEFORE UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add FK from workspace_settings.updated_by → workspace_members
ALTER TABLE workspace_settings
  ADD CONSTRAINT fk_settings_updated_by
  FOREIGN KEY (updated_by) REFERENCES workspace_members(id) ON DELETE SET NULL;

-- TABLE: member_profile_audit
CREATE TABLE IF NOT EXISTS member_profile_audit (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_member_id   UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  changed_by            UUID NOT NULL REFERENCES workspace_members(id),
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field_name            TEXT NOT NULL,
  old_value             TEXT,
  new_value             TEXT,
  change_source         TEXT NOT NULL CHECK (change_source IN ('admin','member'))
);

CREATE INDEX idx_profile_audit_member ON member_profile_audit(workspace_member_id);
CREATE INDEX idx_profile_audit_time ON member_profile_audit(changed_at DESC);

-- TABLE: invite_links
CREATE TABLE IF NOT EXISTS invite_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  created_by      UUID NOT NULL REFERENCES workspace_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at         TIMESTAMPTZ,
  used_by_user_id UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_invite_links_token ON invite_links(token);
CREATE INDEX idx_invite_links_workspace ON invite_links(workspace_id);
CREATE INDEX idx_invite_links_expiry ON invite_links(expires_at);

-- TABLE: groups
CREATE TABLE IF NOT EXISTS groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  created_by    UUID NOT NULL REFERENCES workspace_members(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id              UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  workspace_member_id   UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by              UUID REFERENCES workspace_members(id),
  UNIQUE(group_id, workspace_member_id)
);

CREATE INDEX idx_groups_workspace ON groups(workspace_id);
CREATE INDEX idx_group_members_group ON group_members(group_id);
CREATE INDEX idx_group_members_member ON group_members(workspace_member_id);

-- ================================================================
-- CONTAINERS CONTEXT
-- ================================================================

-- TABLE: containers
CREATE TABLE IF NOT EXISTS containers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  subtitle              TEXT,
  description           TEXT,
  cover_photos          JSONB NOT NULL DEFAULT '[]',
  container_type        TEXT NOT NULL CHECK (container_type IN ('event','recurring')),
  enable_money          BOOLEAN NOT NULL DEFAULT FALSE,
  enable_tasks          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Event fields
  event_date            DATE,
  event_type            TEXT,
  event_type_category   TEXT DEFAULT 'other'
                          CHECK (event_type_category IN (
                            'celebration','memorial','financial','logistical','other'
                          )),

  -- Recurring fields
  recurrence_cadence    TEXT CHECK (recurrence_cadence IN ('monthly','quarterly','yearly','custom', NULL)),
  recurrence_days       INTEGER,
  recurrence_start      DATE,
  recurrence_end        DATE,
  carry_forward_unpaid  BOOLEAN NOT NULL DEFAULT FALSE,
  auto_generate_cycles  BOOLEAN NOT NULL DEFAULT TRUE,

  -- Money
  budget_target         NUMERIC(15,2),
  budget_currency       TEXT,

  -- Public sharing
  public_token          TEXT UNIQUE,
  public_show_names     BOOLEAN NOT NULL DEFAULT TRUE,

  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','completed','archived','cancelled')),

  outcome_details       TEXT,
  outcome_files         JSONB NOT NULL DEFAULT '[]',
  converted_from_id     UUID REFERENCES containers(id),
  created_by            UUID NOT NULL REFERENCES workspace_members(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX idx_containers_workspace
  ON containers(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_containers_type
  ON containers(workspace_id, container_type) WHERE deleted_at IS NULL;
CREATE INDEX idx_containers_public_token
  ON containers(public_token) WHERE public_token IS NOT NULL;

CREATE TRIGGER containers_updated_at BEFORE UPDATE ON containers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- TABLE: container_cycles
CREATE TABLE IF NOT EXISTS container_cycles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id      UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  cycle_number      INTEGER NOT NULL,
  cycle_start       DATE NOT NULL,
  cycle_end         DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('upcoming','open','closed','skipped')),
  total_expected    NUMERIC(15,2),
  total_collected   NUMERIC(15,2) DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  UNIQUE(container_id, cycle_number),
  UNIQUE(container_id, cycle_start)
);

CREATE INDEX idx_cycles_container ON container_cycles(container_id, status);
CREATE INDEX idx_cycles_dates ON container_cycles(cycle_start, cycle_end);

-- TABLE: pool_cycle_overrides
CREATE TABLE IF NOT EXISTS pool_cycle_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id    UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  cycle_start     DATE NOT NULL,
  override_type   TEXT NOT NULL CHECK (override_type IN ('pause_pool','skip_member','adjust_target')),
  member_id       UUID REFERENCES workspace_members(id),
  new_target      NUMERIC(15,2),
  new_currency    TEXT,
  reason          TEXT,
  created_by      UUID NOT NULL REFERENCES workspace_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_overrides_container ON pool_cycle_overrides(container_id);

-- TABLE: container_participants
CREATE TABLE IF NOT EXISTS container_participants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id          UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  workspace_member_id   UUID NOT NULL REFERENCES workspace_members(id),
  role                  TEXT,
  money_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  tasks_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,
  exclude_from_public   BOOLEAN NOT NULL DEFAULT FALSE,
  added_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by              UUID REFERENCES workspace_members(id),
  UNIQUE(container_id, workspace_member_id)
);

CREATE INDEX idx_participants_container ON container_participants(container_id);
CREATE INDEX idx_participants_member ON container_participants(workspace_member_id);

-- TABLE: contributor_targets
CREATE TABLE IF NOT EXISTS contributor_targets (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_participant_id  UUID NOT NULL REFERENCES container_participants(id) ON DELETE CASCADE,
  container_id              UUID NOT NULL REFERENCES containers(id),
  workspace_member_id       UUID NOT NULL REFERENCES workspace_members(id),
  cycle_id                  UUID REFERENCES container_cycles(id),
  target_amount             NUMERIC(15,2) NOT NULL,
  target_currency           TEXT NOT NULL,
  due_date                  DATE,
  is_current                BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by             UUID REFERENCES contributor_targets(id),
  superseded_at             TIMESTAMPTZ,
  set_by                    UUID NOT NULL REFERENCES workspace_members(id),
  set_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one current target per participant per event (no cycle)
CREATE UNIQUE INDEX idx_targets_current_event
  ON contributor_targets(container_participant_id)
  WHERE is_current = TRUE AND cycle_id IS NULL;

-- Only one current target per participant per cycle
CREATE UNIQUE INDEX idx_targets_current_cycle
  ON contributor_targets(container_participant_id, cycle_id)
  WHERE is_current = TRUE AND cycle_id IS NOT NULL;

CREATE INDEX idx_targets_container ON contributor_targets(container_id);
CREATE INDEX idx_targets_member ON contributor_targets(workspace_member_id);

-- ================================================================
-- FINANCE CONTEXT
-- ================================================================

-- TABLE: ledger_entries
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id),
  container_id        UUID NOT NULL REFERENCES containers(id),
  cycle_id            UUID REFERENCES container_cycles(id),
  entry_type          TEXT NOT NULL CHECK (entry_type IN (
                        'contribution','expense','correction','reversal','carry_forward'
                      )),
  contributor_id      UUID REFERENCES workspace_members(id),
  original_amount     NUMERIC(15,2) NOT NULL,
  original_currency   TEXT NOT NULL,
  is_crypto           BOOLEAN NOT NULL DEFAULT FALSE,
  base_amount         NUMERIC(15,2) NOT NULL,
  payment_method      TEXT CHECK (payment_method IN (
                        'cash','bank_transfer','mobile_money','crypto','other', NULL
                      )),
  proofs              JSONB NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                          'pending','proof_uploaded','confirmed','disputed','resolved','reversed'
                        )),
  corrects_entry_id   UUID REFERENCES ledger_entries(id),
  note                TEXT,
  recorded_by         UUID NOT NULL REFERENCES workspace_members(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at        TIMESTAMPTZ,
  confirmed_by        UUID REFERENCES workspace_members(id)
);

CREATE INDEX idx_ledger_workspace_container ON ledger_entries(workspace_id, container_id);
CREATE INDEX idx_ledger_contributor ON ledger_entries(contributor_id);
CREATE INDEX idx_ledger_status ON ledger_entries(status);
CREATE INDEX idx_ledger_cycle ON ledger_entries(cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_ledger_recorded_at ON ledger_entries(recorded_at DESC);

-- TABLE: disputes
CREATE TABLE IF NOT EXISTS disputes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id),
  ledger_entry_id   UUID NOT NULL REFERENCES ledger_entries(id),
  raised_by         UUID NOT NULL REFERENCES workspace_members(id),
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution_note   TEXT,
  resolved_by       UUID REFERENCES workspace_members(id),
  raised_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  notes             JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_disputes_workspace ON disputes(workspace_id, status);
CREATE INDEX idx_disputes_entry ON disputes(ledger_entry_id);

-- ================================================================
-- TASKS
-- ================================================================

-- TABLE: container_tasks
CREATE TABLE IF NOT EXISTS container_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id    UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  assigned_to     UUID REFERENCES workspace_members(id),
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','overdue','cancelled')),
  completed_at    TIMESTAMPTZ,
  completed_by    UUID REFERENCES workspace_members(id),
  completion_note TEXT,
  proofs          JSONB NOT NULL DEFAULT '[]',
  sort_order      INTEGER DEFAULT 0,
  created_by      UUID NOT NULL REFERENCES workspace_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_tasks_container ON container_tasks(container_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_assigned ON container_tasks(assigned_to) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_status ON container_tasks(container_id, status) WHERE deleted_at IS NULL;

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON container_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================
-- TIMELINE
-- ================================================================

-- TABLE: milestones
CREATE TABLE IF NOT EXISTS milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  milestone_date  DATE NOT NULL,
  description     TEXT,
  photos          JSONB NOT NULL DEFAULT '[]',
  milestone_type  TEXT NOT NULL DEFAULT 'custom'
                    CHECK (milestone_type IN (
                      'birth','graduation','wedding','death','migration','achievement','custom'
                    )),
  created_by      UUID NOT NULL REFERENCES workspace_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_milestones_workspace
  ON milestones(workspace_id, milestone_date DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER milestones_updated_at BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================
-- NOTIFICATIONS CONTEXT
-- ================================================================

-- TABLE: notifications
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_id    UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  reference_type  TEXT CHECK (reference_type IN (
                    'container','ledger_entry','dispute','task','milestone','member', NULL
                  )),
  reference_id    UUID,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedup_key       TEXT UNIQUE
);

-- TABLE: notification_deliveries
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('in_app','push','email')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','delivered','failed','skipped')),
  retry_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, is_read);
CREATE INDEX idx_notifications_workspace ON notifications(workspace_id, created_at DESC);
CREATE INDEX idx_notification_deliveries_status
  ON notification_deliveries(status, retry_count)
  WHERE status IN ('pending','failed');

-- ================================================================
-- AUDIT & PROXY
-- ================================================================

-- TABLE: proxy_actions
CREATE TABLE IF NOT EXISTS proxy_actions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id),
  proxy_member_id   UUID NOT NULL REFERENCES workspace_members(id),
  managed_by_id     UUID NOT NULL REFERENCES workspace_members(id),
  action_type       TEXT NOT NULL,
  target_id         UUID,
  action_details    JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_proxy_actions_proxy ON proxy_actions(proxy_member_id);
CREATE INDEX idx_proxy_actions_manager ON proxy_actions(managed_by_id);

-- TABLE: audit_log
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID REFERENCES workspaces(id),
  actor_user_id   UUID REFERENCES users(id),
  actor_member_id UUID REFERENCES workspace_members(id),
  action          TEXT NOT NULL,
  target_type     TEXT,
  target_id       UUID,
  metadata        JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, created_at DESC);

-- ================================================================
-- ROW LEVEL SECURITY (Defence-in-depth safety net)
-- ================================================================

ALTER TABLE containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Members can only see containers in their own workspaces
CREATE POLICY "members_select_containers"
  ON containers FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = TRUE AND deleted_at IS NULL
    )
  );

-- Members can only see ledger entries in their workspaces
CREATE POLICY "members_select_ledger"
  ON ledger_entries FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = TRUE AND deleted_at IS NULL
    )
  );

-- Members can only see milestones in their workspaces
CREATE POLICY "members_select_milestones"
  ON milestones FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = TRUE AND deleted_at IS NULL
    )
  );

-- Members can only see their own notifications
CREATE POLICY "members_select_notifications"
  ON notifications FOR SELECT
  USING (
    recipient_id IN (
      SELECT id FROM workspace_members
      WHERE user_id = auth.uid() AND is_active = TRUE AND deleted_at IS NULL
    )
  );

-- ================================================================
-- STORAGE BUCKET SETUP (run in Supabase dashboard or via SQL)
-- ================================================================

-- Note: Run this in Supabase Storage settings or use the dashboard.
-- INSERT INTO storage.buckets (id, name, public)
-- VALUES ('kith-files', 'kith-files', false)
-- ON CONFLICT (id) DO NOTHING;

-- ================================================================
-- END OF SCHEMA
-- ================================================================
