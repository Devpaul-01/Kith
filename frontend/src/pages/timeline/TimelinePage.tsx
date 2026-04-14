import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { milestoneService } from '@/services/milestone.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Clock, Plus, Trash2 } from 'lucide-react';
import showToast from '@/lib/toast';
import { formatDate } from '@/utils/date';
import type { Milestone } from '@/types/models';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({ title: z.string().min(1), description: z.string().optional(), milestone_date: z.string().min(1, 'Required') });
type Form = z.infer<typeof schema>;

export default function TimelinePage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { data, isLoading } = useQuery({ queryKey: KEYS.timeline(workspaceId), queryFn: () => milestoneService.getTimeline(workspaceId), staleTime: 300_000 });
  const milestones: Milestone[] = (data as { milestones?: Milestone[] })?.milestones ?? [];
  const createMutation = useMutation({ mutationFn: (d: Form) => milestoneService.create(workspaceId, d), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) }); showToast.success('Milestone created'); setShowCreate(false); reset(); }, onError: () => showToast.error('Failed') });
  const deleteMutation = useMutation({ mutationFn: (id: string) => milestoneService.delete(workspaceId, id), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) }); showToast.success('Deleted'); }, onError: () => showToast.error('Failed') });
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between"><h1 className="text-xl font-bold text-text-primary">Timeline</h1>{isAdmin && <Button size="sm" onClick={() => setShowCreate(true)}><Plus size={14} />Add Milestone</Button>}</div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && milestones.length === 0 && <EmptyState icon={<Clock size={36} />} title="No milestones yet" />}
      <div className="relative">
        {milestones.length > 0 && <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-border" />}
        <div className="space-y-6">
          {milestones.map(m => (
            <div key={m.id} className="relative pl-12">
              <div className="absolute left-3.5 top-2 w-3 h-3 rounded-full bg-primary border-2 border-white ring-2 ring-primary-light" />
              <div className="bg-white border border-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1"><p className="font-semibold text-text-primary">{m.title}</p><p className="text-xs text-primary font-medium mt-0.5">{formatDate(m.milestone_date)}</p>{m.description && <p className="text-sm text-text-secondary mt-2">{m.description}</p>}</div>
                  {isAdmin && <button onClick={() => deleteMutation.mutate(m.id)} className="p-1.5 rounded-lg text-slate-300 hover:text-danger hover:bg-red-50 transition-colors flex-shrink-0"><Trash2 size={14} /></button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Modal open={showCreate} onClose={() => { setShowCreate(false); reset(); }} title="Add Milestone">
        <form onSubmit={handleSubmit(d => createMutation.mutate(d))} className="space-y-4">
          <Input label="Title" placeholder="Family reunion 2025" error={errors.title?.message} {...register('title')} />
          <Input label="Date" type="date" error={errors.milestone_date?.message} {...register('milestone_date')} />
          <Textarea label="Description" placeholder="Details..." rows={3} {...register('description')} />
          <div className="flex gap-3 pt-2"><Button variant="secondary" fullWidth type="button" onClick={() => { setShowCreate(false); reset(); }}>Cancel</Button><Button fullWidth type="submit" loading={createMutation.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}
