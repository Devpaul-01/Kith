import { api } from '@/lib/axios';

export interface Invite {
  id: string;
  token: string;
  workspace_id: string;
  created_by: string;
  created_by_name?: string;
  expires_at: string;
  used_at: string | null;
  used_by_user_id: string | null;
  created_at: string;
}

export interface CreateInviteResponse {
  token: string;
  invite_url: string;
  expires_at: string;
}

export const inviteService = {
  // List all invites for a workspace
  list: (workspaceId: string): Promise<{ invites: Invite[] }> => 
    api.get(`/v1/workspaces/${workspaceId}/invites`).then(r => r.data),
  
  // Create an invite link (no email/role needed)
  create: (workspaceId: string): Promise<CreateInviteResponse> => 
    api.post(`/v1/workspaces/${workspaceId}/invites`).then(r => r.data),
  
  // Revoke an invite
  revoke: (workspaceId: string, inviteId: string): Promise<{ message: string }> => 
    api.delete(`/v1/workspaces/${workspaceId}/invites/${inviteId}`).then(r => r.data),
  
  // Preview invite details (public endpoint)
  preview: (token: string): Promise<{
    is_valid: boolean;
    error?: string;
    workspace_name?: string;
    invited_by_name?: string;
    active_containers_preview?: any[];
  }> => api.get(`/v1/public/invites/${token}`).then(r => r.data),
  
  // Accept an invite (public endpoint)
  accept: (token: string): Promise<{ workspace: any; member: any }> => 
    api.post(`/v1/public/invites/${token}/accept`).then(r => r.data),
};