import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Plus, CheckSquare } from 'lucide-react';
import showToast from '@/lib/toast';
import { formatDate } from '@/utils/date';
import type { Task } from '@/types/models';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({ title: z.string().min(1, 'Required'), description: z.string().optional(), due_date: z.string().optional() });
type Form = z.infer<typeof schema>;

export default function ContainerTasksPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { data, isLoading } = useQuery({ queryKey: KEYS.tasks(workspaceId, id!), queryFn: () => taskService.list(workspaceId, id!) });
  const tasks: Task[] = (data as { tasks?: Task[] })?.tasks ?? [];
  const createMutation = useMutation({
    mutationFn: (d: Form) => taskService.create(workspaceId, id!, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId, id!) }); showToast.success('Task created'); setShowAdd(false); reset(); },
    onError: () => showToast.error('Failed to create task'),
  });
  const updateStatus = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: string }) => taskService.update(workspaceId, id!, taskId, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId, id!) }),
    onError: () => showToast.error('Failed to update'),
  });
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Tasks</h2>
        {isAdmin && <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add Task</Button>}
      </div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && tasks.length === 0 && <EmptyState icon={<CheckSquare size={36} />} title="No tasks yet" action={isAdmin && <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add Task</Button>} />}
      <div className="space-y-3">
        {tasks.map(t => (
          <div key={t.id} className="bg-white border border-border rounded-xl p-4 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary text-sm">{t.title}</p>
              {t.description && <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{t.description}</p>}
              <div className="flex items-center gap-3 mt-2 text-xs text-text-secondary">
                {t.assigned_to_name && <span>👤 {t.assigned_to_name}</span>}
                {t.due_date && <span>📅 {formatDate(t.due_date)}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Badge status={t.status} />
              {!isAdmin && t.status === 'pending' && <button className="text-xs text-primary font-semibold hover:underline" onClick={() => updateStatus.mutate({ taskId: t.id, status: 'in_progress' })}>Start</button>}
              {!isAdmin && t.status === 'in_progress' && <button className="text-xs text-success font-semibold hover:underline" onClick={() => updateStatus.mutate({ taskId: t.id, status: 'completed' })}>Complete</button>}
            </div>
          </div>
        ))}
      </div>
      <Modal open={showAdd} onClose={() => { setShowAdd(false); reset(); }} title="Add Task">
        <form onSubmit={handleSubmit(d => createMutation.mutate(d))} className="space-y-4">
          <Input label="Title" placeholder="Task title" error={errors.title?.message} {...register('title')} />
          <Textarea label="Description" placeholder="Details..." rows={2} {...register('description')} />
          <Input label="Due date" type="date" {...register('due_date')} />
          <div className="flex gap-3 pt-2"><Button variant="secondary" fullWidth type="button" onClick={() => { setShowAdd(false); reset(); }}>Cancel</Button><Button fullWidth type="submit" loading={createMutation.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}
