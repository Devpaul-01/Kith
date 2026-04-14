import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { CONTAINER_TYPES, EVENT_CATEGORIES, RECURRENCE_CADENCES } from '@/constants/enums';
import showToast from '@/lib/toast';

const schema = z.object({
  name: z.string().min(2).max(200),
  type: z.enum(['event', 'recurring']),
  category: z.string().optional(),
  description: z.string().max(1000).optional(),
  event_date: z.string().optional(),
  budget_target: z.coerce.number().positive().optional(),
  recurrence_cadence: z.string().optional(),
});
type Form = z.infer<typeof schema>;

interface Props { onClose: () => void; }
export function CreateContainerModal({ onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const { register, handleSubmit, watch, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { type: 'event' } });
  const type = watch('type');
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => containerService.create(workspaceId, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) }); showToast.success('Created!'); onClose(); },
    onError: () => showToast.error('Failed to create.'),
  });
  return (
    <Modal open onClose={onClose} title="Create Event or Pool" size="md">
      <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
        <Input label="Name" placeholder="Annual Celebration" error={errors.name?.message} {...register('name')} />
        <Select label="Type" options={CONTAINER_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))} error={errors.type?.message} {...register('type')} />
        {type === 'event' && <>
          <Select label="Category" options={EVENT_CATEGORIES.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} placeholder="Select category" {...register('category')} />
          <Input label="Event date" type="date" {...register('event_date')} />
        </>}
        {type === 'recurring' && <Select label="Cadence" options={RECURRENCE_CADENCES.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} placeholder="Select cadence" {...register('recurrence_cadence')} />}
        <Input label="Budget target (optional)" type="number" placeholder="50000" {...register('budget_target')} />
        <Textarea label="Description" placeholder="What is this for?" rows={3} {...register('description')} />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth type="button" onClick={onClose}>Cancel</Button>
          <Button fullWidth type="submit" loading={isPending}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}
