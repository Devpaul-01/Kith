import { api } from '@/lib/axios';

// ─── Proof object shape (mirrors what the backend stores) ─────────────────
export interface TaskProof {
  url: string;
  name: string;
  size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

export const taskService = {
  // ── Read ──────────────────────────────────────────────────────────────────

  /** List all tasks in a container (with optional query filters). */
  list: (
    workspaceId: string,
    containerId: string,
    params?: Record<string, unknown>
  ) =>
    api
      .get(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks`, { params })
      .then((r) => r.data),

  /** Get full detail for a single task.
   *  Admin: any task. Member: only tasks assigned to them. */
  getOne: (workspaceId: string, containerId: string, taskId: string) =>
    api
      .get(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}`)
      .then((r) => r.data),

  // ── Create ────────────────────────────────────────────────────────────────

  /** Create a single task (admin only).
   *  Pass `assigned_to` to immediately assign to a participant member ID. */
  create: (
    workspaceId: string,
    containerId: string,
    payload: Record<string, unknown>
  ) =>
    api
      .post(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks`, payload)
      .then((r) => r.data),

  /** Bulk-create tasks (admin only). */
  bulkCreate: (
    workspaceId: string,
    containerId: string,
    payload: { tasks: Record<string, unknown>[] }
  ) =>
    api
      .post(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/bulk`, payload)
      .then((r) => r.data),

  // ── Update ────────────────────────────────────────────────────────────────

  /** General update.
   *  Admin: all fields. Member: status + completion_note only. */
  update: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    payload: Record<string, unknown>
  ) =>
    api
      .patch(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}`,
        payload
      )
      .then((r) => r.data),

  /** Reassign a task to a different participant (admin only). */
  reassign: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    payload: { assigned_to: string }
  ) =>
    api
      .patch(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}/reassign`,
        payload
      )
      .then((r) => r.data),

  /** Hard-override task status (admin only). */
  overrideStatus: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    payload: { status: string; note?: string }
  ) =>
    api
      .patch(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}/status`,
        payload
      )
      .then((r) => r.data),

  // ── Admin confirmation ────────────────────────────────────────────────────

  /** Admin confirms a completed task (optionally with a note).
   *  Task must have status="completed" and not yet be confirmed. */
  confirmTask: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    payload?: { note?: string }
  ) =>
    api
      .post(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}/confirm`,
        payload ?? {}
      )
      .then((r) => r.data),

  // ── Delete ────────────────────────────────────────────────────────────────

  /** Soft-delete a task (admin only). */
  delete: (workspaceId: string, containerId: string, taskId: string) =>
    api
      .delete(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}`)
      .then((r) => r.data),

  // ── Proof upload (2-step) ─────────────────────────────────────────────────

  /** Step 1 — request a pre-signed upload URL. */
  getProofUploadUrl: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    file: { filename: string; content_type: string; file_size: number }
  ) =>
    api
      .post(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}/upload-proof`,
        file
      )
      .then((r) => r.data),

  /** Step 2 — register the uploaded file against the task's proof list. */
  confirmProof: (
    workspaceId: string,
    containerId: string,
    taskId: string,
    payload: { file_path: string; name: string; size: number; mime_type: string }
  ) =>
    api
      .post(
        `/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/${taskId}/confirm-proof`,
        payload
      )
      .then((r) => r.data),

  // ── Export ────────────────────────────────────────────────────────────────

  /** Download tasks as CSV.
   *  Admin → all tasks. Member → only their assigned tasks.
   *  Returns a Blob suitable for client-side download. */
  exportTasks: (workspaceId: string, containerId: string) =>
    api
      .get(`/v1/workspaces/${workspaceId}/containers/${containerId}/tasks/export`, {
        responseType: 'blob',
      })
      .then((r) => r.data as Blob),
};
