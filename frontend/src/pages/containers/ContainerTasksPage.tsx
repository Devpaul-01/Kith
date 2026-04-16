import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/axios';
import { taskService } from '@/services/task.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Plus,
  CheckSquare,
  Trash2,
  UserCheck,
  CheckCircle,
  Eye,
  Download,
  Upload,
} from 'lucide-react';
import showToast from '@/lib/toast';
import { formatDate } from '@/utils/date';
import type { Task } from '@/types/models';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title:       z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  due_date:    z.string().optional(),
  assigned_to: z.string().optional(),
});
type CreateForm = z.infer<typeof createSchema>;

const confirmSchema = z.object({
  note: z.string().optional(),
});
type ConfirmForm = z.infer<typeof confirmSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function triggerCSVDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isImageMime(mime: string) {
  return mime.startsWith('image/');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: StatusBadge with "awaiting confirmation" indicator
// ─────────────────────────────────────────────────────────────────────────────

function TaskStatusChip({ task }: { task: Task }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Badge status={task.status} />
      {task.status === 'completed' && !task.admin_confirmed_at && (
        <span className="text-[10px] text-warning font-medium">Awaiting confirmation</span>
      )}
      {task.admin_confirmed_at && (
        <span className="text-[10px] text-success font-medium flex items-center gap-0.5">
          <CheckCircle size={10} /> Confirmed
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Task card row (shared layout, role-aware actions)
// ─────────────────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task:            Task;
  isAdmin:         boolean;
  currentMemberId: string;
  onDelete:        (t: Task) => void;
  onReassign:      (t: Task) => void;
  onConfirm:       (t: Task) => void;
  onViewDetail:    (t: Task) => void;
  onComplete:      (t: Task) => void;
}

function TaskCard({
  task, isAdmin, currentMemberId,
  onDelete, onReassign, onConfirm, onViewDetail, onComplete,
}: TaskCardProps) {
  const hasProofs    = Array.isArray(task.proofs) && task.proofs.length > 0;
  const needsConfirm = task.status === 'completed' && !task.admin_confirmed_at;
  const isMyTask     = task.assigned_to === currentMemberId;

  return (
    <div className="bg-white border border-border rounded-xl p-4 flex items-start justify-between gap-3">
      {/* Left: info */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-text-primary text-sm">{task.title}</p>
        {task.description && (
          <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{task.description}</p>
        )}
        <div className="flex items-center flex-wrap gap-3 mt-2 text-xs text-text-secondary">
          {task.assigned_to_name && <span>👤 {task.assigned_to_name}</span>}
          {task.due_date         && <span>📅 {formatDate(task.due_date)}</span>}
          {hasProofs             && <span>📎 {task.proofs!.length} proof{task.proofs!.length !== 1 ? 's' : ''}</span>}
          {task.completion_note  && <span className="italic truncate max-w-[180px]">"{task.completion_note}"</span>}
        </div>
      </div>

      {/* Right: status + actions */}
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <TaskStatusChip task={task} />

        {isAdmin ? (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {/* View detail (always available) */}
            <button
              title="View details"
              className="p-1 rounded hover:bg-surface-alt text-text-secondary hover:text-text-primary transition"
              onClick={() => onViewDetail(task)}
            >
              <Eye size={14} />
            </button>

            {/* Confirm — only when completed and not yet confirmed */}
            {needsConfirm && (
              <button
                title={hasProofs ? 'View proof & confirm' : 'Confirm task'}
                className="p-1 rounded hover:bg-surface-alt text-success hover:text-success transition"
                onClick={() => onConfirm(task)}
              >
                <CheckCircle size={14} />
              </button>
            )}

            {/* Reassign */}
            <button
              title="Reassign"
              className="p-1 rounded hover:bg-surface-alt text-text-secondary hover:text-text-primary transition"
              onClick={() => onReassign(task)}
            >
              <UserCheck size={14} />
            </button>

            {/* Delete */}
            <button
              title="Delete task"
              className="p-1 rounded hover:bg-surface-alt text-danger hover:text-danger transition"
              onClick={() => onDelete(task)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          /* Member actions — only shown for tasks assigned to this member */
          <div className="flex items-center gap-2">
            {isMyTask && task.status === 'pending' && (
              <button
                className="text-xs text-primary font-semibold hover:underline"
                onClick={() => onComplete(task)}
              >
                Start
              </button>
            )}
            {isMyTask && task.status === 'in_progress' && (
              <button
                className="text-xs text-success font-semibold hover:underline"
                onClick={() => onComplete(task)}
              >
                Complete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ContainerTasksPage() {
  const { id: containerId } = useParams<{ id: string }>();
  const { workspaceId, member } = useWorkspace();
  const currentMemberId         = member?.id ?? '';
  const isAdmin                 = useIsAdmin();
  const qc                  = useQueryClient();

  // ── Modal visibility state ───────────────────────────────────────────────
  const [showAdd,     setShowAdd]     = useState(false);
  const [detailTask,  setDetailTask]  = useState<Task | null>(null);
  const [confirmTask, setConfirmTask] = useState<Task | null>(null);
  const [reassignTask,setReassignTask]= useState<Task | null>(null);
  const [completeTask,setCompleteTask]= useState<Task | null>(null);

  // Proof file for user complete flow
  const [proofFile,      setProofFile]      = useState<File | null>(null);
  const [proofUploading, setProofUploading] = useState(false);
  const proofInputRef = useRef<HTMLInputElement>(null);

  // Reassign target member id
  const [reassignMemberId, setReassignMemberId] = useState('');

  // ── Forms ────────────────────────────────────────────────────────────────
  const createForm = useForm<CreateForm>({ resolver: zodResolver(createSchema) });
  const confirmForm = useForm<ConfirmForm>({ resolver: zodResolver(confirmSchema) });

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: tasksData, isLoading } = useQuery({
    queryKey: KEYS.tasks(workspaceId, containerId!),
    queryFn:  () => taskService.list(workspaceId, containerId!),
  });
  const tasks: Task[] = (tasksData as { tasks?: Task[] })?.tasks ?? [];

  // Participants for assignee dropdowns (admin only — fetched lazily)
  const { data: participantsData, isLoading: participantsLoading } = useQuery({
    queryKey: ['participants', workspaceId, containerId],
    queryFn:  () =>
      api
        .get(`/v1/workspaces/${workspaceId}/containers/${containerId}/participants`)
        .then((r) => r.data?.participants ?? []),
    enabled: isAdmin && (showAdd || !!reassignTask),
  });
  const participants: Array<{ workspace_member_id: string; display_name: string }> =
    participantsData ?? [];

  // ── Mutations ────────────────────────────────────────────────────────────

  const invalidateTasks = () =>
    qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId, containerId!) });

  const createMutation = useMutation({
    mutationFn: (d: CreateForm) =>
      taskService.create(workspaceId, containerId!, {
        ...d,
        assigned_to: d.assigned_to || undefined,
      }),
    onSuccess: () => {
      invalidateTasks();
      showToast.success('Task created');
      setShowAdd(false);
      createForm.reset();
    },
    onError: () => showToast.error('Failed to create task'),
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) => taskService.delete(workspaceId, containerId!, taskId),
    onSuccess: () => { invalidateTasks(); showToast.success('Task deleted'); },
    onError:   () => showToast.error('Failed to delete task'),
  });

  const updateStatusMutation = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) =>
      taskService.update(workspaceId, containerId!, taskId, { status }),
    onSuccess: () => invalidateTasks(),
    onError:   () => showToast.error('Failed to update status'),
  });

  const reassignMutation = useMutation({
    mutationFn: ({ taskId, memberId }: { taskId: string; memberId: string }) =>
      taskService.reassign(workspaceId, containerId!, taskId, { assigned_to: memberId }),
    onSuccess: () => {
      invalidateTasks();
      showToast.success('Task reassigned');
      setReassignTask(null);
      setReassignMemberId('');
    },
    onError: () => showToast.error('Failed to reassign task'),
  });

  const confirmMutation = useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) =>
      taskService.confirmTask(workspaceId, containerId!, taskId, { note }),
    onSuccess: () => {
      invalidateTasks();
      showToast.success('Task confirmed');
      setConfirmTask(null);
      confirmForm.reset();
    },
    onError: () => showToast.error('Failed to confirm task'),
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleDelete(task: Task) {
    if (!window.confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
    deleteMutation.mutate(task.id);
  }

  /** User complete flow — opens modal so they can optionally attach proof */
  function handleOpenComplete(task: Task) {
    setCompleteTask(task);
    setProofFile(null);
  }
async function handleSubmitComplete() {
  if (!completeTask) return;
  setProofUploading(true);

  try {
    // 1. Upload proof if selected
    if (proofFile) {
      console.log("Step 1: Getting upload URL for:", proofFile.name);
      
      // ✅ Fix: Pass the file object correctly
      const result = await taskService.getProofUploadUrl(
        workspaceId, 
        containerId!, 
        completeTask.id,
        {
          filename: proofFile.name,
          content_type: proofFile.type,
          file_size: proofFile.size
        }
      );
      
      console.log("Step 2: Upload URL received:", result);
      
      const { upload_url, file_path } = result;

      // Step 3: Upload file to the pre-signed URL
      console.log("Step 3: Uploading file to:", upload_url);
      const uploadResponse = await fetch(upload_url, {
        method: 'PUT',
        body: proofFile,
        headers: { 
          'Content-Type': proofFile.type,
          'Content-Length': proofFile.size.toString()
        },
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed: ${uploadResponse.status}`);
      }
      
      console.log("Step 4: Upload successful, confirming proof...");

      // Step 4: Confirm proof with backend
      await taskService.confirmProof(workspaceId, containerId!, completeTask.id, {
        file_path,
        name: proofFile.name,
        size: proofFile.size,
        mime_type: proofFile.type,
      });
      
      console.log("Step 5: Proof confirmed!");
    }

    // 2. Advance status
    const nextStatus = completeTask.status === 'pending' ? 'in_progress' : 'completed';
    console.log("Step 6: Updating task status to:", nextStatus);
    
    await taskService.update(workspaceId, containerId!, completeTask.id, { 
      status: nextStatus,
      ...(nextStatus === 'completed' && { completion_note: 'Task completed with proof' })
    });

    invalidateTasks();
    showToast.success(nextStatus === 'completed' ? 'Task marked complete' : 'Task started');
    setCompleteTask(null);
    setProofFile(null);
  } catch (error: any) {
    console.error('Complete task error:', error);
    showToast.error(error?.message || 'Failed to update task');
  } finally {
    setProofUploading(false);
  }
}
  

  async function handleExport() {
    try {
      const blob = await taskService.exportTasks(workspaceId, containerId!);
      const filename = isAdmin
        ? `tasks-${containerId}-${Date.now()}.csv`
        : `my-tasks-${Date.now()}.csv`;
      triggerCSVDownload(blob, filename);
    } catch {
      showToast.error('Export failed');
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      {/* Hidden file input hoisted to component root so the ref is always mounted
          and proofInputRef.current?.click() never fires on a null ref */}
      <input
        ref={proofInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
      />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Tasks</h2>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleExport}>
            <Download size={13} /> Export
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={13} /> Add Task
            </Button>
          )}
        </div>
      </div>

      {/* ── Admin summary strip ─────────────────────────────────────────────── */}
      {isAdmin && tasks.length > 0 && (() => {
        const needConfirm = tasks.filter(
          (t) => t.status === 'completed' && !t.admin_confirmed_at
        ).length;
        return needConfirm > 0 ? (
          <div className="rounded-lg bg-warning/10 border border-warning/30 px-4 py-2 text-sm text-warning font-medium">
            {needConfirm} task{needConfirm !== 1 ? 's' : ''} awaiting your confirmation
          </div>
        ) : null;
      })()}

      {/* ── Loading / Empty ─────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex justify-center py-8"><Spinner /></div>
      )}
      {!isLoading && tasks.length === 0 && (
        <EmptyState
          icon={<CheckSquare size={36} />}
          title="No tasks yet"
          action={
            isAdmin ? (
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <Plus size={13} /> Add Task
              </Button>
            ) : undefined
          }
        />
      )}

      {/* ── Task list ──────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            isAdmin={isAdmin}
            currentMemberId={currentMemberId}
            onDelete={handleDelete}
            onReassign={(task) => { setReassignTask(task); setReassignMemberId(task.assigned_to ?? ''); }}
            onConfirm={(task) => { setConfirmTask(task); confirmForm.reset(); }}
            onViewDetail={setDetailTask}
            onComplete={handleOpenComplete}
          />
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ADMIN — Add Task Modal                                              */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <Modal open={showAdd} onClose={() => { setShowAdd(false); createForm.reset(); }} title="New Task">
        <form
          onSubmit={createForm.handleSubmit((d) => createMutation.mutate(d))}
          className="space-y-4"
        >
          <Input
            label="Title"
            placeholder="What needs to be done?"
            error={createForm.formState.errors.title?.message}
            autoFocus
            {...createForm.register('title')}
          />
          <Input
            label="Due date (optional)"
            type="date"
            {...createForm.register('due_date')}
          />
          <Textarea
            label="Notes (optional)"
            placeholder="Add any extra details..."
            rows={2}
            {...createForm.register('description')}
          />

          {/* Assign to participant */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Assign to (optional)
            </label>
            {participantsLoading ? (
              <div className="text-xs text-text-secondary py-1">Loading members…</div>
            ) : (
              <select
                className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                {...createForm.register('assigned_to')}
              >
                <option value="">— Unassigned —</option>
                {participants.map((p) => (
                  <option key={p.workspace_member_id} value={p.workspace_member_id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex gap-3 pt-1">
            <Button
              variant="secondary"
              fullWidth
              type="button"
              onClick={() => { setShowAdd(false); createForm.reset(); }}
            >
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={createMutation.isPending}>
              Create Task
            </Button>
          </div>
        </form>
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ADMIN — Task Detail Modal                                           */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!detailTask}
        onClose={() => setDetailTask(null)}
        title="Task Detail"
      >
        {detailTask && (
          <div className="space-y-4 text-sm">
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Title</p>
              <p className="font-semibold text-text-primary">{detailTask.title}</p>
            </div>
            {detailTask.description && (
              <div>
                <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Description</p>
                <p className="text-text-primary">{detailTask.description}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Status</p>
                <TaskStatusChip task={detailTask} />
              </div>
              {detailTask.assigned_to_name && (
                <div>
                  <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Assigned to</p>
                  <p>{detailTask.assigned_to_name}</p>
                </div>
              )}
              {detailTask.due_date && (
                <div>
                  <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Due</p>
                  <p>{formatDate(detailTask.due_date)}</p>
                </div>
              )}
              {detailTask.completed_at && (
                <div>
                  <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Completed</p>
                  <p>{formatDate(detailTask.completed_at)}</p>
                </div>
              )}
            </div>
            {detailTask.completion_note && (
              <div>
                <p className="text-xs text-text-secondary uppercase tracking-wide mb-0.5">Member note</p>
                <p className="italic text-text-secondary">"{detailTask.completion_note}"</p>
              </div>
            )}

            {/* Proof files */}
            {Array.isArray(detailTask.proofs) && detailTask.proofs.length > 0 && (
              <div>
                <p className="text-xs text-text-secondary uppercase tracking-wide mb-2">
                  Proof files ({detailTask.proofs.length})
                </p>
                <div className="space-y-2">
                  {detailTask.proofs.map((proof, i) => (
                    <div key={i} className="border border-border rounded-lg overflow-hidden">
                      {isImageMime(proof.mime_type) ? (
                        <img
                          src={proof.url}
                          alt={proof.name}
                          className="w-full max-h-64 object-contain bg-surface-alt"
                        />
                      ) : (
                        <div className="flex items-center justify-between px-3 py-2 bg-surface-alt">
                          <span className="text-xs truncate text-text-secondary">{proof.name}</span>
                          <a
                            href={proof.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline ml-2 flex-shrink-0"
                          >
                            View
                          </a>
                        </div>
                      )}
                      <p className="text-[10px] text-text-secondary px-3 py-1">
                        Uploaded {formatDate(proof.uploaded_at)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detailTask.admin_confirmed_at && (
              <div className="rounded-lg bg-success/10 border border-success/30 px-3 py-2 text-xs text-success">
                ✓ Confirmed {formatDate(detailTask.admin_confirmed_at)}
                {detailTask.admin_note && ` — "${detailTask.admin_note}"`}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setDetailTask(null); setReassignTask(detailTask); }}
              >
                <UserCheck size={13} /> Reassign
              </Button>
              {detailTask.status === 'completed' && !detailTask.admin_confirmed_at && (
                <Button
                  size="sm"
                  onClick={() => { setDetailTask(null); setConfirmTask(detailTask); }}
                >
                  <CheckCircle size={13} /> Confirm
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setDetailTask(null)}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ADMIN — Confirm Task Modal                                          */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!confirmTask}
        onClose={() => { setConfirmTask(null); confirmForm.reset(); }}
        title="Confirm Task"
      >
        {confirmTask && (
          <form
            onSubmit={confirmForm.handleSubmit((d) =>
              confirmMutation.mutate({ taskId: confirmTask.id, note: d.note })
            )}
            className="space-y-4"
          >
            <div className="rounded-lg bg-surface-alt px-4 py-3 text-sm">
              <p className="font-medium text-text-primary">{confirmTask.title}</p>
              {confirmTask.assigned_to_name && (
                <p className="text-text-secondary text-xs mt-0.5">
                  Completed by {confirmTask.assigned_to_name}
                </p>
              )}
              {confirmTask.completion_note && (
                <p className="text-text-secondary text-xs italic mt-1">
                  "{confirmTask.completion_note}"
                </p>
              )}
            </div>

            {/* Show proofs if any */}
            {Array.isArray(confirmTask.proofs) && confirmTask.proofs.length > 0 && (
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">
                  Submitted proof ({confirmTask.proofs.length})
                </p>
                <div className="space-y-2">
                  {confirmTask.proofs.map((proof, i) => (
                    <div key={i} className="border border-border rounded-lg overflow-hidden">
                      {isImageMime(proof.mime_type) ? (
                        <img
                          src={proof.url}
                          alt={proof.name}
                          className="w-full max-h-48 object-contain bg-surface-alt"
                        />
                      ) : (
                        <div className="flex items-center justify-between px-3 py-2 bg-surface-alt">
                          <span className="text-xs truncate">{proof.name}</span>
                          <a
                            href={proof.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline ml-2"
                          >
                            Open
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Textarea
              label="Confirmation note (optional)"
              placeholder="Any comments for the member…"
              rows={2}
              {...confirmForm.register('note')}
            />

            <div className="flex gap-3">
              <Button
                variant="secondary"
                fullWidth
                type="button"
                onClick={() => { setConfirmTask(null); confirmForm.reset(); }}
              >
                Cancel
              </Button>
              <Button fullWidth type="submit" loading={confirmMutation.isPending}>
                <CheckCircle size={14} /> Confirm Task
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* ADMIN — Reassign Modal                                              */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!reassignTask}
        onClose={() => { setReassignTask(null); setReassignMemberId(''); }}
        title="Reassign Task"
      >
        {reassignTask && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Reassigning: <span className="font-medium text-text-primary">{reassignTask.title}</span>
            </p>

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Assign to
              </label>
              {participantsLoading ? (
                <div className="text-xs text-text-secondary py-1">Loading members…</div>
              ) : (
                <select
                  className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                  value={reassignMemberId}
                  onChange={(e) => setReassignMemberId(e.target.value)}
                >
                  <option value="">— Unassigned —</option>
                  {participants.map((p) => (
                    <option key={p.workspace_member_id} value={p.workspace_member_id}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex gap-3">
              <Button
                variant="secondary"
                fullWidth
                onClick={() => { setReassignTask(null); setReassignMemberId(''); }}
              >
                Cancel
              </Button>
              <Button
                fullWidth
                loading={reassignMutation.isPending}
                disabled={!reassignMemberId && reassignMemberId !== ''}
                onClick={() =>
                  reassignMutation.mutate({ taskId: reassignTask.id, memberId: reassignMemberId })
                }
              >
                Reassign
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MEMBER — Complete Task Modal (optional proof upload)                */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <Modal
        open={!!completeTask}
        onClose={() => { setCompleteTask(null); setProofFile(null); }}
        title={completeTask?.status === 'pending' ? 'Start Task' : 'Complete Task'}
      >
        {completeTask && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              Task: <span className="font-medium text-text-primary">{completeTask.title}</span>
            </p>

            {/* Proof upload — only shown when completing (not starting) */}
            {completeTask.status === 'in_progress' && (
              <div>
                <p className="text-xs font-medium text-text-secondary mb-2">
                  Proof of completion (optional)
                </p>
                {proofFile ? (
                  <div className="flex items-center justify-between border border-border rounded-lg px-3 py-2 bg-surface-alt">
                    <span className="text-xs truncate text-text-primary">{proofFile.name}</span>
                    <button
                      className="text-xs text-danger hover:underline ml-2 flex-shrink-0"
                      onClick={() => { setProofFile(null); if (proofInputRef.current) proofInputRef.current.value = ''; }}
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="w-full flex items-center justify-center gap-2 border border-dashed border-border rounded-lg py-3 text-sm text-text-secondary hover:border-primary hover:text-primary transition"
                    onClick={() => proofInputRef.current?.click()}
                  >
                    <Upload size={14} /> Attach proof image or PDF
                  </button>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <Button
                variant="secondary"
                fullWidth
                onClick={() => { setCompleteTask(null); setProofFile(null); }}
              >
                Cancel
              </Button>
              <Button
                fullWidth
                loading={proofUploading}
                onClick={handleSubmitComplete}
              >
                {completeTask.status === 'pending' ? 'Start Task' : 'Mark Complete'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

    </div>
  );
}
