// services/group.service.ts
import { api } from '@/lib/axios';

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

export interface CreateGroupPayload {
  name: string;
  description?: string;
  member_ids?: string[];
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string | null;
}

export const groupService = {
  list: (workspaceId: string): Promise<{ groups: Group[] }> =>
    api.get(`/v1/workspaces/${workspaceId}/groups`).then(r => r.data),

  get: (workspaceId: string, groupId: string): Promise<{ group: Group; members: GroupMember[] }> =>
    api.get(`/v1/workspaces/${workspaceId}/groups/${groupId}`).then(r => r.data),

  create: (workspaceId: string, payload: CreateGroupPayload) =>
    api.post(`/v1/workspaces/${workspaceId}/groups`, payload).then(r => r.data),

  update: (workspaceId: string, groupId: string, payload: UpdateGroupPayload) =>
    api.patch(`/v1/workspaces/${workspaceId}/groups/${groupId}`, payload).then(r => r.data),

  delete: (workspaceId: string, groupId: string) =>
    api.delete(`/v1/workspaces/${workspaceId}/groups/${groupId}`).then(r => r.data),

  addMembers: (workspaceId: string, groupId: string, memberIds: string[]) =>
    api.post(`/v1/workspaces/${workspaceId}/groups/${groupId}/members`, { member_ids: memberIds }).then(r => r.data),

  removeMember: (workspaceId: string, groupId: string, memberId: string) =>
    api.delete(`/v1/workspaces/${workspaceId}/groups/${groupId}/members/${memberId}`).then(r => r.data),
};