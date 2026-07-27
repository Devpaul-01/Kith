// In models.ts - replace the existing User interface
export interface User {
  id: string;
  email: string;
  full_name: string;
  bio?: string;
  country_of_residence?: string;
  timezone?: string;
  avatar_url?: string;
  preferred_language?: string;
  push_enabled: boolean;
  push_token?: string;
  push_token_platform?: 'web' | 'ios' | 'android';
  email_digest_enabled: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at?: string;
}

export interface UserContact {
  id: string;
  user_id: string;
  type: 'email_secondary' | 'whatsapp' | 'phone' | 'telegram' | 'signal' | 'instagram' | 'facebook' | 'twitter' | 'linkedin' | 'custom';
  label?: string;
  value: string;
  country_code?: string;
  is_primary: boolean;
  is_verified: boolean;
  verified_at?: string;
  created_at: string;
}
export interface Membership{member_id:string;role:'admin'|'member';workspace_id:string;display_name:string;workspace_name:string;base_currency:string;}
export interface Workspace{id:string;name:string;description?:string;base_currency:string;family_type?:string;avatar_url?:string;created_at:string;updated_at:string;}
export interface WorkspaceMember{id:string;user_id:string|null;workspace_id:string;display_name:string;role:'admin'|'member';is_proxy:boolean;is_active:boolean;engagement_level?:EngagementLevel;email?:string;avatar_url?:string;created_at:string;updated_at:string;}
export interface WorkspaceSettings{reminder_days_before:number;overdue_notify_after_days:number;weekly_digest_enabled:boolean;reminder_template?:string;invite_message_template?:string;}
// In models.ts - replace the existing Group interface
export interface Group {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  member_count: number;
  members?: GroupMember[];
  created_at: string;
  created_by?: string;
}

export interface GroupMember {
  id: string;
  display_name: string;
  role: 'admin' | 'member';
  is_proxy: boolean;
  relationship_to_head?: string;
  relationship_category?: string;
}
export type ContainerType='event'|'recurring';
export type ContainerStatus='active'|'completed'|'archived';
export type EventCategory='celebration'|'memorial'|'financial'|'logistical'|'other';
export type EventTypeCategory='celebration'|'memorial'|'financial'|'logistical'|'other';
export type RecurrenceCadence='monthly'|'quarterly'|'yearly'|'custom'|'weekly';
export type LedgerStatus='pending'|'proof_uploaded'|'confirmed'|'disputed'|'resolved';
export type EntryType='contribution'|'correction'|'adjustment';
export type TaskStatus='pending'|'in_progress'|'completed'|'cancelled';
export type DisputeStatus='open'|'resolved';
export type EngagementLevel='active'|'quiet'|'inactive';

// ── Container ─────────────────────────────────────────────────────────────────
export interface Container {
  // Primary identifiers
  id: string;
  workspace_id: string;

  // Basic info
  name: string;
  subtitle: string | null;
  description: string | null;
  cover_photos: Array<{ url: string; path: string; uploaded_at?: string }>;

  // Type & status
  container_type: ContainerType;
  status: ContainerStatus;

  // Feature flags
  enable_money: boolean;
  enable_tasks: boolean;

  // Event fields
  event_date: string | null;
  event_type: string | null;
  event_type_category: EventTypeCategory;

  // Recurring fields
  recurrence_cadence: RecurrenceCadence | null;
  recurrence_days: number | null;
  recurrence_start: string | null;
  recurrence_end: string | null;
  carry_forward_unpaid: boolean;
  auto_generate_cycles: boolean;

  // Money/Budget
  budget_target: number | null;
  budget_currency: string | null;

  // Public sharing
  public_token: string | null;
  public_show_names: boolean;

  // Outcome
  outcome_details: string | null;
  outcome_files: any[];

  // Relations
  converted_from_id: string | null;
  created_by: string;

  // Timestamps
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;

  // Computed/aggregated fields returned by list & detail endpoints
  progress_pct?: number;
  total_confirmed?: number;
  total_expected?: number;
  participant_count?: number;
}

// Updated to match the actual API response from participant_controller.js
export interface Participant {
  id: string;
  container_id: string;
  workspace_member_id: string;
  display_name: string;
  is_proxy?: boolean;
  member_role?: 'admin' | 'member';
  money_enabled: boolean;
  tasks_enabled: boolean;
  role?: string | null;
  notes?: string | null;
  exclude_from_public?: boolean;
  added_by?: string;
  created_at: string;
  // current non-cycle target fields (flattened from contributor_targets)
  target_amount?: number;
  target_currency?: string;
  due_date?: string | null;
  target_id?: string;
}

// Target history entry returned by getTargetHistory
export interface ContributorTarget {
  id: string;
  container_participant_id: string;
  container_id: string;
  workspace_member_id: string;
  target_amount: number;
  target_currency: string;
  due_date: string | null;
  is_current: boolean;
  cycle_id: string | null;
  set_at: string;
  set_by: string;
  set_by_name?: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

// Single row returned inside cycle_targets array by getCycleTargets
export interface CycleTargetEntry {
  cycle: {
    id: string;
    cycle_number: number;
    cycle_start: string;
    cycle_end: string;
    status: string;
  };
  target: {
    id: string;
    amount: number;
    currency: string;
  } | null;
  confirmed_paid_base: number;
  status: 'pending' | 'partial' | 'paid' | 'overdue' | 'skipped';
}

export interface LedgerProofFile {
  url: string;
  name: string;
  size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

export interface LedgerEntry {
  id: string;
  workspace_id: string;
  container_id: string;
  cycle_id?: string | null;
  entry_type: EntryType;
  contributor_id: string;
  contributor_name?: string;
  original_amount: number;
  original_currency: string;
  base_amount: number;
  payment_method?: string | null;
  note?: string | null;
  is_crypto: boolean;
  status: LedgerStatus;
  proofs?: LedgerProofFile[];
  corrects_entry_id?: string | null;
  recorded_by?: string;
  recorded_by_name?: string;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
  confirmed_by_name?: string;
  recorded_at: string;
  created_at: string;
  updated_at: string;
}

export interface Dispute{id:string;ledger_entry_id:string;workspace_id:string;raised_by_member_id:string;raised_by_name:string;reason:string;status:DisputeStatus;resolution_note?:string;resolved_by_name?:string;resolved_at?:string;created_at:string;notes?:DisputeNote[];}
export interface DisputeNote{id:string;dispute_id:string;member_id:string;member_name:string;note:string;created_at:string;}

// In models.ts - replace the existing Milestone interface
export interface Milestone {
  id: string;
  workspace_id: string;
  container_id?: string;
  title: string;
  description?: string;
  milestone_date: string;
  milestone_type?: 'birth' | 'graduation' | 'wedding' | 'death' | 'migration' | 'achievement' | 'custom';
  photos?: Array<{
    url: string;
    name: string;
    size: number;
    mime_type: string;
    uploaded_by: string;
    uploaded_at: string;
  }>;
  created_by?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}
export interface Notification{id:string;user_id:string;workspace_id?:string;type:string;title:string;body:string;is_read:boolean;reference_type?:'ledger_entry'|'task'|'dispute'|'container'|'workspace';reference_id?:string;created_at:string;}
export interface Invite{id:string;workspace_id:string;token:string;email?:string;role:'admin'|'member';invited_by_name:string;expires_at:string;accepted_at?:string;created_at:string;}

// ── Cycle ─────────────────────────────────────────────────────────────────────
// NOTE: DB columns are cycle_start / cycle_end (not start_date / end_date)
export interface Cycle {
  id: string;
  container_id: string;
  cycle_number: number;
  cycle_start: string;   // DB column name
  cycle_end: string;     // DB column name
  status: 'active' | 'open' | 'upcoming' | 'closed' | 'skipped';
  total_expected: number;
  total_collected: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor_name: string;
  description: string;
  created_at: string;
  target_type?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RecurringPool{
  id:string;
  name:string;
  current_cycle: { id: string; cycle_start: string; cycle_end: string; status: string; total_expected: number | null; total_collected: number } | null;
}

export interface FileInfo{filename:string;content_type:string;file_size:number;}
export interface ActiveEvent{id:string;name:string;event_date?:string;status:ContainerStatus;progress_pct:number;days_until?:number;total_confirmed?:number;budget_target?:number;}
export interface Deadline{contributor_name:string;container_name:string;container_id:string;due_date:string;days_remaining:number;amount?:number;}
export interface ContainerSummary{container:Container;total_confirmed:number;total_expected:number;total_pending:number;progress_pct:number;participant_count:number;confirmed_count:number;pending_count:number;currency:string;}
export interface DashboardData{
  workspace_summary:{member_count:number;admin_count:number;proxy_count:number};
  active_events:ActiveEvent[];
  recurring_pools:RecurringPool[];
  upcoming_deadlines:Deadline[];
  pending_confirmations:LedgerEntry[];
  recent_activity:AuditEntry[];
  unread_notification_count:number;
  unread_activity_count:number;
  open_disputes_count?: number | null;
  my_tasks_summary?: {
    pending_count: number;
    in_progress_count: number;
    overdue_count: number;
    next_due: { id: string; title: string; due_date: string; container_id: string; container_name: string | null } | null;
  };
  engagement_summary?: {
    quiet_count: number;
    inactive_count: number;
    inactive_members: { member_id: string; display_name: string }[];
  } | null;
  recent_milestones?: {
    id: string;
    title: string;
    description?: string;
    milestone_date: string;
    milestone_type?: string;
    cover_photo: { url: string; name: string } | null;
  }[];
}
export interface TaskProofFile {
  url:         string;
  name:        string;
  size:        number;
  mime_type:   string;
  uploaded_by: string;
  uploaded_at: string;
}

export interface Task {
  id:           string;
  container_id: string;
  workspace_id?: string;
  title:            string;
  description?:     string;
  completion_note?: string;
  status: TaskStatus;
  assigned_to?:      string;
  assigned_to_name?: string;
  sort_order?: number;
  due_date?:   string;
  proofs?: TaskProofFile[];
  completed_at?: string;
  completed_by?: string;
  admin_confirmed_at?: string;
  admin_confirmed_by?: string;
  admin_note?:         string;
  created_by?:      string;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
}
