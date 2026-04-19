// services/milestone.service.ts
import { api } from '@/lib/axios';

export interface CreateMilestonePayload {
  title: string;
  milestone_date: string;
  description?: string;
  milestone_type?: string;
}

export interface UpdateMilestonePayload {
  title?: string;
  milestone_date?: string;
  description?: string;
  milestone_type?: string;
}

export interface TimelineItem {
  type: 'container_completed' | 'milestone';
  date: string;
  title: string;
  description: string | null;
  photos: Array<{ url: string; name: string; size: number; mime_type: string }> | null;
  reference_id: string;
  reference_type: 'container' | 'milestone';
}

export interface MilestonePhotoFile {
  url: string;
  name: string;
  size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

export const milestoneService = {
  getTimeline: (workspaceId: string, params?: Record<string, unknown>): Promise<{ items: TimelineItem[] }> =>
    api.get(`/v1/workspaces/${workspaceId}/timeline`, { params }).then(r => r.data),

  create: (workspaceId: string, payload: CreateMilestonePayload) =>
    api.post(`/v1/workspaces/${workspaceId}/milestones`, payload).then(r => r.data),

  update: (workspaceId: string, milestoneId: string, payload: UpdateMilestonePayload) =>
    api.patch(`/v1/workspaces/${workspaceId}/milestones/${milestoneId}`, payload).then(r => r.data),

  delete: (workspaceId: string, milestoneId: string) =>
    api.delete(`/v1/workspaces/${workspaceId}/milestones/${milestoneId}`).then(r => r.data),

  getPhotoUploadUrl: (workspaceId: string, milestoneId: string, fileData: { filename: string; content_type: string; file_size: number }) =>
    api.post(`/v1/workspaces/${workspaceId}/milestones/${milestoneId}/photos/upload-url`, fileData).then(r => r.data),

  confirmPhoto: (workspaceId: string, milestoneId: string, payload: { file_path: string; name: string; size: number; mime_type: string }) =>
    api.post(`/v1/workspaces/${workspaceId}/milestones/${milestoneId}/photos/confirm`, payload).then(r => r.data),
};