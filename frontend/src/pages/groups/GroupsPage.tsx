import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { groupService } from '@/services/group.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Plus, Users2, Trash2 } from 'lucide-react';
import showToast from '@/lib/toast';
import type { Group } from '@/types/models';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({ name: z.string().min(1, 'Required'), description: z.string().optional() });
type Form = z.infer<typeof schema>;

export default function GroupsPage() {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { data, isLoading } = useQuery({ queryKey: KEYS.groups(workspaceId), queryFn: () => groupService.list(workspaceId) });
  const groups: Group[] = (data as { groups?: Group[] })?.groups ?? [];
  const createMutation = useMutation({ mutationFn: (d: Form) => groupService.create(workspaceId, d), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) }); showToast.success('Group created'); setShowCreate(false); reset(); }, onError: () => showToast.error('Failed to create') });
  const deleteMutation = useMutation({ mutationFn: (id: string) => groupService.delete(workspaceId, id), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) }); showToast.success('Deleted'); }, onError: () => showToast.error('Failed to delete') });
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between"><h1 className="text-xl font-bold text-text-primary">Groups</h1><Button size="sm" onClick={() => setShowCreate(true)}><Plus size={14} />Create Group</Button></div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && groups.length === 0 && <EmptyState icon={<Users2 size={36} />} title="No groups yet" action={<Button size="sm" onClick={() => setShowCreate(true)}><Plus size={14} />Create Group</Button>} />}
      <div className="space-y-3">
        {groups.map(g => (
          <Card key={g.id} className="flex items-center justify-between">
            <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center"><Users2 className="text-accent" size={18} /></div><div><p className="font-medium text-text-primary">{g.name}</p>{g.description && <p className="text-xs text-text-secondary">{g.description}</p>}<p className="text-xs text-text-secondary mt-0.5">{g.member_count ?? 0} members</p></div></div>
            <button onClick={() => deleteMutation.mutate(g.id)} disabled={deleteMutation.isPending} className="p-2 rounded-lg text-slate-400 hover:text-danger hover:bg-red-50 transition-colors"><Trash2 size={16} /></button>
          </Card>
        ))}
      </div>
      <Modal open={showCreate} onClose={() => { setShowCreate(false); reset(); }} title="Create Group">
        <form onSubmit={handleSubmit(d => createMutation.mutate(d))} className="space-y-4">
          <Input label="Group name" placeholder="Core Team" error={errors.name?.message} {...register('name')} />
          <Textarea label="Description" placeholder="Optional..." rows={2} {...register('description')} />
          <div className="flex gap-3 pt-2"><Button variant="secondary" fullWidth type="button" onClick={() => { setShowCreate(false); reset(); }}>Cancel</Button><Button fullWidth type="submit" loading={createMutation.isPending}>Create</Button></div>
        </form>
      </Modal>
    </div>
  );
}
