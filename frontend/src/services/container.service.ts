// services/container.service.ts
import { api } from '@/lib/axios';

// Types
export interface CreateContainerPayload {
  name: string;
  subtitle?: string | null;
  container_type: 'event' | 'recurring';
  event_type?: string | null;
  event_type_category?: string | null;
  description?: string | null;
  event_date?: string | null;
  enable_money?: boolean;
  enable_tasks?: boolean;
  budget_target?: number | null;
  budget_currency?: string;
  recurrence_cadence?: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
  recurrence_days?: number | null;
  recurrence_start?: string | null;
  recurrence_end?: string | null;
  carry_forward_unpaid?: boolean;
}

export interface UpdateContainerPayload {
  name?: string;
  subtitle?: string | null;
  description?: string | null;
  event_date?: string | null;
  event_type?: string | null;
  event_type_category?: string | null;
  budget_target?: number | null;
  budget_currency?: string;
  enable_money?: boolean;
  enable_tasks?: boolean;
  carry_forward_unpaid?: boolean;
  recurrence_end?: string | null;
  public_show_names?: boolean;
}

export interface Container {
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  container_type: 'event' | 'recurring';
  status: 'active' | 'completed' | 'archived';
  enable_money: boolean;
  enable_tasks: boolean;
  event_date: string | null;
  event_type: string | null;
  event_type_category: string | null;
  budget_target: number | null;
  budget_currency: string | null;
  recurrence_cadence: string | null;
  recurrence_days: number | null;
  recurrence_start: string | null;
  recurrence_end: string | null;
  carry_forward_unpaid: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  completed_at: string | null;
  public_token: string | null;
  public_show_names: boolean;
  outcome_details: string | null;
  outcome_files: string[] | null;
  converted_from_id: string | null;
  workspace_id: string;
}

export interface ContainerListResponse {
  containers: Container[];
  meta: {
    total: number;
    active_count: number;
  };
}

export const containerService = {
  /**
   * List all containers in a workspace
   */
  list: (workspaceId: string, params?: Record<string, unknown>): Promise<ContainerListResponse> => {
    return api.get(`/v1/workspaces/${workspaceId}/containers`, { params }).then(r => r.data);
  },

  /**
   * Get a single container by ID
   */
  get: (workspaceId: string, containerId: string): Promise<{ container: Container; current_cycle: any; participant_count: number; current_user_participation: any }> => {
    return api.get(`/v1/workspaces/${workspaceId}/containers/${containerId}`).then(r => r.data);
  },

  /**
   * Create a new container (event or recurring pool)
   */
  // services/container.service.ts
// Update the create method to better handle errors

create: async (workspaceId: string, payload: CreateContainerPayload): Promise<{ container: Container }> => {
  try {
    console.log('📤 Creating container with payload:', JSON.stringify(payload, null, 2));
    
    const formattedPayload = {
      ...payload,
      subtitle: payload.subtitle || null,
      description: payload.description || null,
      event_date: payload.event_date || null,
      event_type: payload.event_type || null,
      event_type_category: payload.event_type_category || null,
      enable_money: payload.enable_money !== undefined ? payload.enable_money : true,
      enable_tasks: payload.enable_tasks || false,
      budget_target: payload.budget_target || null,
      budget_currency: payload.budget_currency || 'USD',
      recurrence_cadence: payload.recurrence_cadence || null,
      recurrence_days: payload.recurrence_days || null,
      recurrence_start: payload.recurrence_start || null,
      recurrence_end: payload.recurrence_end || null,
      carry_forward_unpaid: payload.carry_forward_unpaid || false,
    };
    
    console.log('📤 Formatted payload:', JSON.stringify(formattedPayload, null, 2));
    
    const response = await api.post(`/v1/workspaces/${workspaceId}/containers`, formattedPayload);
    console.log('✅ Create container response:', response.data);
    return response.data;
  } catch (error: any) {
    console.error('❌ Create container failed:', error);
    
    if (error.response) {
      // Server responded with error
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response headers:', error.response.headers);
      
      // Throw a more informative error
      const errorMessage = error.response.data?.details 
        ? JSON.stringify(error.response.data.details)
        : error.response.data?.error || error.message;
      
      throw new Error(`Create container failed: ${errorMessage}`);
    } else if (error.request) {
      // Request was made but no response
      console.error('No response received:', error.request);
      throw new Error('Network error - no response from server');
    } else {
      // Something else
      console.error('Error setting up request:', error.message);
      throw error;
    }
  }
},

  /**
   * Update an existing container
   */
  update: (workspaceId: string, containerId: string, payload: UpdateContainerPayload): Promise<{ container: Container }> => {
    return api.patch(`/v1/workspaces/${workspaceId}/containers/${containerId}`, payload).then(r => r.data);
  },

  /**
   * Delete (soft delete) a container
   */
  delete: (workspaceId: string, containerId: string): Promise<{ message: string }> => {
    return api.delete(`/v1/workspaces/${workspaceId}/containers/${containerId}`).then(r => r.data);
  },

  /**
   * Mark a container as completed
   */
  complete: (workspaceId: string, containerId: string, outcomeDetails?: string, outcomeFiles?: string[]): Promise<{ container: Container }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/complete`, {
      outcome_details: outcomeDetails,
      outcome_files: outcomeFiles,
    }).then(r => r.data);
  },

  /**
   * Archive a container
   */
  archive: (workspaceId: string, containerId: string): Promise<{ container: Container }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/archive`).then(r => r.data);
  },

  /**
   * Generate a public shareable link for a container
   */
  generatePublicLink: (workspaceId: string, containerId: string): Promise<{ public_url: string; public_token: string }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/generate-public-link`).then(r => r.data);
  },

  /**
   * Get container summary with participant contributions
   */
  getSummary: (workspaceId: string, containerId: string): Promise<{
    container: Container;
    total_expected_base: number;
    total_confirmed_base: number;
    total_pending_base: number;
    progress_pct: number | null;
    participants: any[];
  }> => {
    return api.get(`/v1/workspaces/${workspaceId}/containers/${containerId}/summary`).then(r => r.data);
  },

  /**
   * List cycles for recurring containers
   */
  listCycles: (workspaceId: string, containerId: string, params?: Record<string, unknown>): Promise<{
    cycles: any[];
    meta: {
      total: number;
      pagination: { page: number; per_page: number };
    };
  }> => {
    return api.get(`/v1/workspaces/${workspaceId}/containers/${containerId}/cycles`, { params }).then(r => r.data);
  },

  /**
   * Get upload URL for cover photo
   */
  getCoverPhotoUploadUrl: (workspaceId: string, containerId: string, fileData: {
    filename: string;
    content_type: string;
    file_size: number;
  }): Promise<{ upload_url: string; file_url: string; file_key: string }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/cover-photos/upload-url`, fileData).then(r => r.data);
  },

  /**
   * Get upload URL for outcome file (when completing a container)
   */
  getOutcomeFileUploadUrl: (workspaceId: string, containerId: string, fileData: {
    filename: string;
    content_type: string;
    file_size: number;
  }): Promise<{ upload_url: string; file_url: string; file_key: string }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/outcome-files/upload-url`, fileData).then(r => r.data);
  },

  /**
   * Convert an event container to recurring
   */
  convertToRecurring: (workspaceId: string, containerId: string, payload: {
    new_name?: string;
    recurrence_cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    recurrence_days?: number[];
    recurrence_start: string;
    recurrence_end?: string | null;
    carry_forward_unpaid?: boolean;
  }): Promise<{ new_container: Container; source_container_id: string }> => {
    return api.post(`/v1/workspaces/${workspaceId}/containers/${containerId}/convert-to-recurring`, payload).then(r => r.data);
  },
};