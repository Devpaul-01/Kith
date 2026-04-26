import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { workspaceService } from '@/services/workspace.service';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useMutation } from '@tanstack/react-query';
import showToast from '@/lib/toast';
import { SUPPORTED_CURRENCIES, CURRENCY_LABELS } from '@/constants/currencies';
import { FAMILY_TYPES } from '@/constants/enums';
import type { Workspace, WorkspaceMember } from '@/types/models';

const schema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  base_currency: z.string().min(1, 'Required'),
  family_type: z.string().optional(),
});
type Form = z.infer<typeof schema>;

export default function CreateWorkspacePage() {
  const nav = useNavigate();
  const { setWorkspace } = useWorkspaceStore();
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => workspaceService.create(d),
    onSuccess: (d: unknown) => {
      const r = d as { workspace: Workspace; member: WorkspaceMember };
      setWorkspace(r.workspace, r.member);
      showToast.success('Workspace created!');
      nav('/app/dashboard');
    },
    onError: () => showToast.error('Failed to create workspace.'),
  });
  return (
    <div className="min-h-screen bg-surface-page flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-border p-8 space-y-5">
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Create workspace</h2>
          <p className="text-sm text-text-secondary mt-1">Set up your family or community space.</p>
        </div>
        <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
          <Input label="Workspace name" placeholder="Smith Family" error={errors.name?.message} {...register('name')} />
          <Textarea label="Description" placeholder="What is this workspace for?" rows={3} {...register('description')} />
          <Select label="Base currency" options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: `${c} — ${CURRENCY_LABELS[c] ?? c}` }))} placeholder="Select currency" error={errors.base_currency?.message} {...register('base_currency')} />
          <Select label="Family type" options={FAMILY_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))} placeholder="Select type (optional)" {...register('family_type')} />
          <Button type="submit" fullWidth loading={isPending}>Create workspace</Button>
        </form>
      </div>
    </div>
  );
}
