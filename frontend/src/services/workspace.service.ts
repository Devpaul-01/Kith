// services/workspace.service.ts
import { api } from '@/lib/axios';

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  base_currency: string;
  family_type: 'extended' | 'event' | 'pool';
  avatar_url: string | null;
  plan: 'free' | 'core' | 'pro';
  plan_expires_at: string | null;
  visibility: 'private' | 'public';
  bank_details?: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  role: 'admin' | 'member';
  display_name: string;
}

export interface WorkspaceSettings {
  notification_prefs?: {
    reminder_days_before: number[];
    overdue_notify_after_days: number[];
    weekly_digest_enabled: boolean;
  };
  reminder_templates?: {
    due_soon: string;
    overdue: string;
  };
  invite_message?: {
    template: string;
  };
}

export interface UpdateWorkspacePayload {
  name?: string;
  description?: string | null;
  base_currency?: string;
  family_type?: 'extended' | 'event' | 'pool';
  avatar_url?: string | null;
  visibility?: 'private' | 'public';
  bank_details?: Record<string, unknown>;
}

export const workspaceService = {
  list: (): Promise<{ memberships: Array<{
    member_id: string;
    role: string;
    display_name: string;
    workspace_id: string;
    workspace_name: string;
    base_currency: string;
    avatar_url: string | null;
    plan: string;
  }> }> => api.get('/v1/workspaces').then(r => r.data),

  create: (payload: { name: string; description?: string; base_currency: string; family_type?: string }) =>
    api.post('/v1/workspaces', payload).then(r => r.data),

  get: (id: string): Promise<{ workspace: Workspace; current_member: WorkspaceMember }> =>
    api.get(`/v1/workspaces/${id}`).then(r => r.data),

  update: (id: string, payload: UpdateWorkspacePayload) =>
    api.patch(`/v1/workspaces/${id}`, payload).then(r => r.data),

  delete: (id: string) => api.delete(`/v1/workspaces/${id}`).then(r => r.data),
  getOverdueSummary: (workspaceId: string) =>
  api.get(`/v1/workspaces/${workspaceId}/overdue-summary`).then(r => r.data),


  getDashboard: (workspaceId: string) =>
    api.get(`/v1/workspaces/${workspaceId}/dashboard`).then(r => r.data),

  getSettings: (id: string): Promise<{ settings: WorkspaceSettings }> =>
    api.get(`/v1/workspaces/${id}/settings`).then(r => r.data),

  updateSettings: (id: string, payload: Partial<WorkspaceSettings>) =>
    api.patch(`/v1/workspaces/${id}/settings`, payload).then(r => r.data),

  // Avatar upload
  getAvatarUploadUrl: (workspaceId: string, fileData: { filename: string; content_type: string; file_size: number }) =>
    api.post(`/v1/workspaces/${workspaceId}/avatar-upload-url`, fileData).then(r => r.data),
};