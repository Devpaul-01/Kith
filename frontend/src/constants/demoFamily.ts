/**
 * constants/demoFamily.ts
 *
 * Single source of demo data for the Kith landing page.
 * Every landing section pulls from this file so the same fictional
 * family — the Adeyemis — appears consistently across every screenshot,
 * live component, and animation. When real product screenshots are
 * ready, swap the corresponding LIVE_* export for an <img> and delete
 * the unused fixture — the shapes below match the real domain models
 * in models.ts (Container, Task, LedgerEntry, WorkspaceMember, etc.)
 * so porting is mechanical, not a rewrite.
 */

import type {
  Container,
  WorkspaceMember,
  LedgerEntry,
  Task,
  AuditEntry,
  Milestone,
  DashboardData,
  ActiveEvent,
  RecurringPool,
  Deadline,
} from '@/types/models';

// ── Workspace ─────────────────────────────────────────────────────────────
export const DEMO_WORKSPACE = {
  id: 'ws_demo_adeyemi',
  name: 'The Adeyemi Family',
  base_currency: 'GBP',
  family_type: 'extended_family',
};

// ── Members (includes one proxy member: Grandma Ruth) ────────────────────
export const DEMO_MEMBERS: WorkspaceMember[] = [
  { id: 'mem_david', user_id: 'u_david', workspace_id: DEMO_WORKSPACE.id, display_name: 'David Adeyemi', role: 'admin', is_proxy: false, is_active: true, engagement_level: 'active', avatar_url: undefined, created_at: '2024-02-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: 'mem_sarah', user_id: 'u_sarah', workspace_id: DEMO_WORKSPACE.id, display_name: 'Sarah Adeyemi', role: 'admin', is_proxy: false, is_active: true, engagement_level: 'active', created_at: '2024-02-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: 'mem_michael', user_id: 'u_michael', workspace_id: DEMO_WORKSPACE.id, display_name: 'Michael Adeyemi', role: 'member', is_proxy: false, is_active: true, engagement_level: 'active', created_at: '2024-03-10T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: 'mem_esther', user_id: 'u_esther', workspace_id: DEMO_WORKSPACE.id, display_name: 'Esther Adeyemi', role: 'member', is_proxy: false, is_active: true, engagement_level: 'quiet', created_at: '2024-03-10T00:00:00Z', updated_at: '2026-06-14T00:00:00Z' },
  { id: 'mem_grace', user_id: 'u_grace', workspace_id: DEMO_WORKSPACE.id, display_name: 'Grace Adeyemi', role: 'member', is_proxy: false, is_active: true, engagement_level: 'active', created_at: '2024-05-22T00:00:00Z', updated_at: '2026-07-10T00:00:00Z' },
  { id: 'mem_daniel', user_id: 'u_daniel', workspace_id: DEMO_WORKSPACE.id, display_name: 'Daniel Adeyemi', role: 'member', is_proxy: false, is_active: true, engagement_level: 'active', created_at: '2024-05-22T00:00:00Z', updated_at: '2026-07-05T00:00:00Z' },
  { id: 'mem_ruth', user_id: null, workspace_id: DEMO_WORKSPACE.id, display_name: 'Grandma Ruth', role: 'member', is_proxy: true, is_active: true, engagement_level: 'quiet', created_at: '2024-02-03T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
];

export const PROXY_REPRESENTATIVE: Record<string, string> = {
  mem_ruth: 'Represented by David Adeyemi',
};

// ── Containers (events + recurring pools) ────────────────────────────────
export const DEMO_CONTAINERS: Partial<Container>[] = [
  {
    id: 'c_birthday',
    workspace_id: DEMO_WORKSPACE.id,
    name: "Grandma Ruth's 70th Birthday",
    subtitle: 'Family celebration — Lagos, September',
    container_type: 'event',
    status: 'active',
    enable_money: true,
    enable_tasks: true,
    event_date: '2026-09-12',
    event_type_category: 'celebration',
    budget_target: 2400,
    budget_currency: 'GBP',
    progress_pct: 68,
    total_confirmed: 1632,
    total_expected: 2400,
    participant_count: 7,
  },
  {
    id: 'c_healthcare',
    workspace_id: DEMO_WORKSPACE.id,
    name: "Parents' Monthly Healthcare Support",
    subtitle: 'Recurring — closes on the 28th each month',
    container_type: 'recurring',
    status: 'active',
    enable_money: true,
    enable_tasks: false,
    recurrence_cadence: 'monthly',
    carry_forward_unpaid: true,
    auto_generate_cycles: true,
    budget_target: 600,
    budget_currency: 'GBP',
    progress_pct: 83,
    total_confirmed: 500,
    total_expected: 600,
    participant_count: 5,
  },
  {
    id: 'c_reunion',
    workspace_id: DEMO_WORKSPACE.id,
    name: 'Family Reunion — Lagos',
    subtitle: 'August, three-day gathering',
    container_type: 'event',
    status: 'active',
    enable_money: true,
    enable_tasks: true,
    event_date: '2026-08-22',
    event_type_category: 'celebration',
    budget_target: 3200,
    budget_currency: 'GBP',
    progress_pct: 41,
    total_confirmed: 1312,
    total_expected: 3200,
    participant_count: 7,
  },
  {
    id: 'c_education',
    workspace_id: DEMO_WORKSPACE.id,
    name: "Michael's University Education Fund",
    subtitle: 'Recurring — quarterly',
    container_type: 'recurring',
    status: 'active',
    enable_money: true,
    enable_tasks: false,
    recurrence_cadence: 'quarterly',
    carry_forward_unpaid: false,
    auto_generate_cycles: true,
    budget_target: 1500,
    budget_currency: 'GBP',
    progress_pct: 100,
    total_confirmed: 1500,
    total_expected: 1500,
    participant_count: 4,
  },
  {
    id: 'c_emergency',
    workspace_id: DEMO_WORKSPACE.id,
    name: 'Emergency Medical Support — Uncle Femi',
    subtitle: 'One-off, opened 3 days ago',
    container_type: 'event',
    status: 'active',
    enable_money: true,
    enable_tasks: false,
    event_type_category: 'financial',
    budget_target: 900,
    budget_currency: 'GBP',
    progress_pct: 89,
    total_confirmed: 801,
    total_expected: 900,
    participant_count: 6,
  },
];

// ── Ledger entries (for history / proof / confirmation views) ────────────
export const DEMO_LEDGER: Partial<LedgerEntry>[] = [
  { id: 'l1', container_id: 'c_birthday', contributor_name: 'David Adeyemi', original_amount: 300, original_currency: 'GBP', base_amount: 300, status: 'confirmed', recorded_at: '2026-07-02T09:14:00Z', payment_method: 'bank_transfer' },
  { id: 'l2', container_id: 'c_birthday', contributor_name: 'Sarah Adeyemi', original_amount: 300, original_currency: 'GBP', base_amount: 300, status: 'confirmed', recorded_at: '2026-07-04T18:02:00Z', payment_method: 'bank_transfer' },
  { id: 'l3', container_id: 'c_birthday', contributor_name: 'Grace Adeyemi', original_amount: 240, original_currency: 'GBP', base_amount: 240, status: 'proof_uploaded', recorded_at: '2026-07-11T12:41:00Z', payment_method: 'mobile_money' },
  { id: 'l4', container_id: 'c_birthday', contributor_name: 'Daniel Adeyemi', original_amount: 240, original_currency: 'GBP', base_amount: 240, status: 'confirmed', recorded_at: '2026-07-13T08:20:00Z', payment_method: 'bank_transfer' },
  { id: 'l5', container_id: 'c_healthcare', contributor_name: 'Michael Adeyemi', original_amount: 100, original_currency: 'GBP', base_amount: 100, status: 'confirmed', recorded_at: '2026-07-20T07:55:00Z' },
  { id: 'l6', container_id: 'c_healthcare', contributor_name: 'Esther Adeyemi', original_amount: 100, original_currency: 'GBP', base_amount: 100, status: 'pending', recorded_at: '2026-07-24T10:00:00Z' },
  { id: 'l7', container_id: 'c_emergency', contributor_name: 'Uncle Femi (proxy)', original_amount: 150, original_currency: 'USD', base_amount: 119, status: 'confirmed', recorded_at: '2026-07-24T16:30:00Z' },
];

// ── Tasks ─────────────────────────────────────────────────────────────────
export const DEMO_TASKS: Partial<Task>[] = [
  { id: 't1', container_id: 'c_birthday', title: 'Book the hall', assigned_to_name: 'David Adeyemi', status: 'completed', due_date: '2026-07-01' },
  { id: 't2', container_id: 'c_birthday', title: 'Order the cake', assigned_to_name: 'Grace Adeyemi', status: 'in_progress', due_date: '2026-09-05' },
  { id: 't3', container_id: 'c_birthday', title: 'Call relatives in Lagos', assigned_to_name: 'Esther Adeyemi', status: 'completed', due_date: '2026-08-15' },
  { id: 't4', container_id: 'c_birthday', title: 'Arrange decorations', assigned_to_name: 'Daniel Adeyemi', status: 'pending', due_date: '2026-09-08' },
  { id: 't5', container_id: 'c_reunion', title: 'Confirm venue catering', assigned_to_name: 'Sarah Adeyemi', status: 'in_progress', due_date: '2026-08-10' },
];

// ── Activity / audit timeline ─────────────────────────────────────────────
export const DEMO_ACTIVITY: Partial<AuditEntry>[] = [
  { id: 'a1', action: 'contribution_confirmed', actor_name: 'David Adeyemi', description: 'Confirmed £300 toward Grandma Ruth\u2019s 70th Birthday', created_at: '2026-07-24T16:30:00Z' },
  { id: 'a2', action: 'task_completed', actor_name: 'Esther Adeyemi', description: 'Completed "Call relatives in Lagos"', created_at: '2026-07-22T11:05:00Z' },
  { id: 'a3', action: 'member_joined', actor_name: 'Daniel Adeyemi', description: 'Joined the family workspace', created_at: '2026-06-30T09:00:00Z' },
  { id: 'a4', action: 'cycle_closed', actor_name: 'System', description: 'July cycle closed for Parents\u2019 Monthly Healthcare Support', created_at: '2026-06-28T00:00:00Z' },
  { id: 'a5', action: 'milestone_reached', actor_name: 'Sarah Adeyemi', description: 'Family Reunion passed 40% funded', created_at: '2026-06-18T14:22:00Z' },
  { id: 'a6', action: 'event_completed', actor_name: 'Grace Adeyemi', description: 'Christmas Celebration marked complete', created_at: '2025-12-27T20:00:00Z' },
];

// ── Milestones ─────────────────────────────────────────────────────────────
export const DEMO_MILESTONES: Partial<Milestone>[] = [
  { id: 'm1', title: 'Christmas Celebration', milestone_date: '2025-12-25', milestone_type: 'achievement' },
  { id: 'm2', title: "Michael's Graduation", milestone_date: '2026-06-14', milestone_type: 'graduation' },
  { id: 'm3', title: "Grace & Tobi's Wedding", milestone_date: '2026-03-08', milestone_type: 'wedding' },
];

// ── Dashboard summary (drives the hero / "how it works" screenshots) ─────
export const DEMO_DASHBOARD: Partial<DashboardData> = {
  workspace_summary: { member_count: 7, admin_count: 2, proxy_count: 1 },
  active_events: DEMO_CONTAINERS.filter((c) => c.container_type === 'event') as ActiveEvent[],
  recurring_pools: DEMO_CONTAINERS.filter((c) => c.container_type === 'recurring') as unknown as RecurringPool[],
  upcoming_deadlines: [
    { contributor_name: 'Grace Adeyemi', container_name: "Grandma Ruth's 70th Birthday", container_id: 'c_birthday', due_date: '2026-08-01', days_remaining: 5, amount: 240 },
    { contributor_name: 'Esther Adeyemi', container_name: "Parents' Monthly Healthcare Support", container_id: 'c_healthcare', due_date: '2026-07-28', days_remaining: 1, amount: 100 },
  ] as Deadline[],
  pending_confirmations: DEMO_LEDGER.filter((l) => l.status === 'proof_uploaded') as LedgerEntry[],
  recent_activity: DEMO_ACTIVITY as AuditEntry[],
  unread_notification_count: 3,
  unread_activity_count: 6,
};

// ── Currency bar (featured subset — copy must not imply a hard limit) ────
export const FEATURED_CURRENCIES = ['USD', 'GBP', 'NGN', 'GHS', 'KES', 'ZAR', 'INR', 'CAD', 'EUR', 'AED'] as const;
