// services/member.service.ts
import { api } from '@/lib/axios';

export interface CreateMemberPayload {
  display_name: string;
  role?: 'admin' | 'member';
  is_proxy?: boolean;
  proxy_managed_by?: string | null;
  relationship_to_head?: string | null;
  relationship_category?: 'blood' | 'marriage' | 'in_law' | 'friend' | 'other';
  date_of_birth?: string | null;
  admin_notes?: string | null;
}

export interface UpdateMemberPayload {
  display_name?: string;
  role?: 'admin' | 'member';
  is_proxy?: boolean;
  proxy_managed_by?: string | null;
  is_active?: boolean;
  relationship_to_head?: string | null;
  relationship_category?: 'blood' | 'marriage' | 'in_law' | 'friend' | 'other';
  date_of_birth?: string | null;
  admin_notes?: string | null;
  version?: string; // for optimistic locking
}

export interface ProfileHistoryEntry {
  id: string;
  workspace_member_id: string;
  changed_by: string;
  changed_by_name?: string;
  changed_at: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  change_source: 'admin' | 'member';
}

export interface ContributionSummary {
  total_containers: number;
  total_confirmed_count: number;
  total_paid_base_currency: number;
  last_contribution_date: string | null;
  containers: Array<{
    container_name: string;
    paid_base_amount: number;
    target_amount: number | null;
    target_currency: string | null;
    status: 'paid' | 'pending';
  }>;
}

export interface EngagementMember {
  member_id: string;
  display_name: string;
  last_activity: string | null;
  confirmed_contributions_count: number;
  pending_contributions_count: number;
  overdue_count: number;
  engagement_level: 'active' | 'quiet' | 'inactive';
}

export const memberService = {
  list: (workspaceId: string, params?: Record<string, unknown>) =>
    api.get(`/v1/workspaces/${workspaceId}/members`, { params }).then(r => r.data),

  get: (workspaceId: string, memberId: string) =>
    api.get(`/v1/workspaces/${workspaceId}/members/${memberId}`).then(r => r.data),

  create: (workspaceId: string, payload: CreateMemberPayload) =>
    api.post(`/v1/workspaces/${workspaceId}/members`, payload).then(r => r.data),

  update: (workspaceId: string, memberId: string, payload: UpdateMemberPayload) =>
    api.patch(`/v1/workspaces/${workspaceId}/members/${memberId}`, payload).then(r => r.data),

  delete: (workspaceId: string, memberId: string, force?: boolean) =>
    api.delete(`/v1/workspaces/${workspaceId}/members/${memberId}${force ? '?force=true' : ''}`).then(r => r.data),

  getEngagement: (workspaceId: string): Promise<{ members: EngagementMember[] }> =>
    api.get(`/v1/workspaces/${workspaceId}/members/engagement`).then(r => r.data),

  getContributionSummary: (workspaceId: string, memberId: string): Promise<ContributionSummary> =>
    api.get(`/v1/workspaces/${workspaceId}/members/${memberId}/contribution-summary`).then(r => r.data),

  getProfileHistory: (workspaceId: string, memberId: string): Promise<{ history: ProfileHistoryEntry[] }> =>
    api.get(`/v1/workspaces/${workspaceId}/members/${memberId}/profile-history`).then(r => r.data),
};