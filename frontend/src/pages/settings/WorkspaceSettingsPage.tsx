import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspaceService } from '@/services/workspace.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import showToast from '@/lib/toast';
import { SUPPORTED_CURRENCIES, CURRENCY_LABELS } from '@/constants/currencies';
import { AlertTriangle } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

const schema = z.object({ name: z.string().min(2).max(100), description: z.string().max(500).optional(), base_currency: z.string() });
type Form = z.infer<typeof schema>;

export default function WorkspaceSettingsPage() {
  const { workspaceId, workspace } = useWorkspace();
  const { clear: clearWs } = useWorkspaceStore();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [confirmName, setConfirmName] = useState('');
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { name: workspace?.name, description: workspace?.description, base_currency: workspace?.base_currency } });
  const updateMutation = useMutation({ mutationFn: (d: Form) => workspaceService.update(workspaceId, d), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.workspace(workspaceId) }); showToast.success('Settings saved'); }, onError: () => showToast.error('Failed to save') });
  const deleteMutation = useMutation({ mutationFn: () => workspaceService.delete(workspaceId), onSuccess: () => { clearWs(); qc.removeQueries({ queryKey: KEYS.workspace(workspaceId) }); showToast.success('Workspace deleted'); nav('/workspace/select'); }, onError: () => showToast.error('Failed to delete') });
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Workspace Settings</h1>
      <Card>
        <form onSubmit={handleSubmit(d => updateMutation.mutate(d))} className="space-y-4">
          <Input label="Name" error={errors.name?.message} {...register('name')} />
          <Textarea label="Description" rows={3} {...register('description')} />
          <Select label="Base currency" options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: `${c} — ${CURRENCY_LABELS[c] ?? c}` }))} {...register('base_currency')} />
          <Button type="submit" loading={updateMutation.isPending}>Save changes</Button>
        </form>
      </Card>
      <Card className="border-danger/30">
        <div className="flex items-center gap-2 mb-4"><AlertTriangle className="text-danger" size={18} /><h2 className="font-bold text-danger">Danger Zone</h2></div>
        <p className="text-sm text-text-secondary mb-4">Deleting this workspace will soft-delete it. Data is preserved for audit purposes.</p>
        <div className="space-y-3">
          <Input label={`Type "${workspace?.name ?? ''}" to confirm`} placeholder={workspace?.name ?? ''} value={confirmName} onChange={e => setConfirmName(e.target.value)} />
          <Button variant="danger" disabled={confirmName !== workspace?.name} onClick={() => deleteMutation.mutate()} loading={deleteMutation.isPending}>Delete Workspace</Button>
        </div>
      </Card>
    </div>
  );
}
