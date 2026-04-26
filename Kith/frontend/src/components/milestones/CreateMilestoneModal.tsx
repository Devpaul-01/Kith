// components/milestones/CreateMilestoneModal.tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { milestoneService } from '@/services/milestone.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';

const MILESTONE_TYPES = [
  { value: 'birth', label: '🎂 Birth' },
  { value: 'graduation', label: '🎓 Graduation' },
  { value: 'wedding', label: '💍 Wedding' },
  { value: 'death', label: '🕊️ Memorial' },
  { value: 'migration', label: '✈️ Migration' },
  { value: 'achievement', label: '🏆 Achievement' },
  { value: 'custom', label: '📌 Custom' },
];

const createSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  milestone_date: z.string().min(1, 'Date is required'),
  description: z.string().optional(),
  milestone_type: z.string().default('custom'),
});

type CreateForm = z.infer<typeof createSchema>;

interface CreateMilestoneModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

export function CreateMilestoneModal({ open, onClose, workspaceId }: CreateMilestoneModalProps) {
  const qc = useQueryClient();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      milestone_type: 'custom',
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateForm) => milestoneService.create(workspaceId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) });
      showToast.success('Milestone created');
      reset();
      onClose();
    },
    onError: () => showToast.error('Failed to create milestone'),
  });

  const onSubmit = (data: CreateForm) => {
    createMutation.mutate(data);
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Milestone">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Title *"
          placeholder="e.g., Family Reunion 2025"
          error={errors.title?.message}
          {...register('title')}
        />
        <Input
          label="Date *"
          type="date"
          error={errors.milestone_date?.message}
          {...register('milestone_date')}
        />
        <Select
          label="Type"
          options={MILESTONE_TYPES}
          {...register('milestone_type')}
        />
        <Textarea
          label="Description (optional)"
          placeholder="Add details about this milestone..."
          rows={3}
          {...register('description')}
        />
        <div className="flex gap-3 pt-2">
          <Button
            variant="secondary"
            fullWidth
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button fullWidth type="submit" loading={createMutation.isPending}>
            Create Milestone
          </Button>
        </div>
      </form>
    </Modal>
  );
}