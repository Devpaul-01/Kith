import { api } from '@/lib/axios';

export interface ParticipantInput {
  workspace_member_id: string;
  money_enabled?: boolean;
  tasks_enabled?: boolean;
  role?: string;
  notes?: string;
  target?: {
    amount: number;
    currency: string;
    due_date?: string;
  };
}

export interface UpdateParticipantPayload {
  money_enabled?: boolean;
  tasks_enabled?: boolean;
  role?: string | null;
  notes?: string | null;
  exclude_from_public?: boolean;
}

export interface SetTargetPayload {
  amount: number;
  currency: string;
  due_date?: string;
}

export interface CycleOverridePayload {
  override_type: 'skip_member' | 'adjust_target' | 'pause_pool';
  member_id?: string;
  new_target?: number;
  new_currency?: string;
  reason?: string;
}

export const participantService = {
  list: (w: string, c: string) =>
    api.get(`/v1/workspaces/${w}/containers/${c}/participants`).then(r => r.data),

  add: (w: string, c: string, participants: ParticipantInput[]) =>
    api.post(`/v1/workspaces/${w}/containers/${c}/participants`, { participants }).then(r => r.data),

  addFromGroup: (w: string, c: string, data: { group_id: string; money_enabled?: boolean; tasks_enabled?: boolean }) =>
    api.post(`/v1/workspaces/${w}/containers/${c}/participants/from-group`, data).then(r => r.data),

  update: (w: string, c: string, pId: string, data: UpdateParticipantPayload) =>
    api.patch(`/v1/workspaces/${w}/containers/${c}/participants/${pId}`, data).then(r => r.data),

  remove: (w: string, c: string, pId: string) =>
    api.delete(`/v1/workspaces/${w}/containers/${c}/participants/${pId}`).then(r => r.data),

  setTarget: (w: string, c: string, pId: string, data: SetTargetPayload) =>
    api.post(`/v1/workspaces/${w}/containers/${c}/participants/${pId}/set-target`, data).then(r => r.data),

  // --- newly added ---

  getTargetHistory: (w: string, c: string, pId: string) =>
    api.get(`/v1/workspaces/${w}/containers/${c}/participants/${pId}/target-history`).then(r => r.data),

  getCycleTargets: (w: string, c: string, pId: string) =>
    api.get(`/v1/workspaces/${w}/containers/${c}/participants/${pId}/cycle-targets`).then(r => r.data),

  overrideCycle: (w: string, c: string, cycleId: string, data: CycleOverridePayload) =>
    api.post(`/v1/workspaces/${w}/containers/${c}/cycles/${cycleId}/override`, data).then(r => r.data),
};
