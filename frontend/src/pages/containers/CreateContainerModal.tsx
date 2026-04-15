// CreateContainerModal.tsx
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
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { CONTAINER_TYPES, EVENT_CATEGORIES, RECURRENCE_CADENCES } from '@/constants/enums';
import showToast from '@/lib/toast';

const schema = z.object({
  name: z.string().min(2).max(200),
  subtitle: z.string().max(200).optional(),
  container_type: z.enum(['event', 'recurring']),
  event_type: z.string().max(100).optional(),
  event_type_category: z.string().optional(),
  description: z.string().max(1000).optional(),
  event_date: z.string().optional(),
  enable_money: z.boolean().default(true),
  enable_tasks: z.boolean().default(false),
  budget_target: z.coerce.number().positive().optional(),
  budget_currency: z.string().default('USD').optional(),
  recurrence_cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly', 'custom']).optional(),
  recurrence_days: z.coerce.number().optional(),
  recurrence_start: z.string().optional(),
  recurrence_end: z.string().optional(),
  carry_forward_unpaid: z.boolean().default(false),
});

type Form = z.infer<typeof schema>;

interface Props { onClose: () => void; }

export function CreateContainerModal({ onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<Form>({ 
    resolver: zodResolver(schema), 
    defaultValues: { 
      container_type: 'event',
      enable_money: true,
      enable_tasks: false,
      carry_forward_unpaid: false,
      budget_currency: 'USD',
    } 
  });
  
  const containerType = watch('container_type');
  const enableMoney = watch('enable_money');
  const recurrenceCadence = watch('recurrence_cadence');
  
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => containerService.create(workspaceId, d),
    onSuccess: () => { 
      qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) }); 
      showToast.success('Container created successfully!'); 
      onClose(); 
    },
    onError: (error: any) => {
      const errorMessage = error?.response?.data?.error?.message || 'Failed to create.';
      showToast.error(errorMessage);
    },
  });
  
  return (
    <Modal open onClose={onClose} title="Create Event or Pool" size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        <form onSubmit={handleSubmit((d) => mutate(d))} className="space-y-4">
          {/* Basic Info */}
          <Input 
            label="Name" 
            placeholder="Annual Celebration" 
            error={errors.name?.message} 
            {...register('name')} 
          />
          
          <Input 
            label="Subtitle (optional)" 
            placeholder="A brief subtitle" 
            error={errors.subtitle?.message} 
            {...register('subtitle')} 
          />
          
          <Select 
            label="Type" 
            options={CONTAINER_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))} 
            error={errors.container_type?.message} 
            {...register('container_type')} 
          />
          
          <Textarea 
            label="Description (optional)" 
            placeholder="What is this for?" 
            rows={3} 
            {...register('description')} 
          />
          
          {/* Event-specific fields */}
          {containerType === 'event' && (
            <>
              <Input 
                label="Event Type" 
                placeholder="e.g., Wedding, Birthday, Graduation, Holiday" 
                {...register('event_type')} 
              />
              
              <Select 
                label="Category" 
                options={EVENT_CATEGORIES.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} 
                placeholder="Select category"
                {...register('event_type_category')} 
              />
              
              <Input 
                label="Event Date" 
                type="date" 
                {...register('event_date')} 
              />
            </>
          )}
          
          {/* Recurring-specific fields */}
          {containerType === 'recurring' && (
            <>
              <Select 
                label="Recurrence Cadence" 
                options={[
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'monthly', label: 'Monthly' },
                  { value: 'quarterly', label: 'Quarterly' },
                  { value: 'yearly', label: 'Yearly' },
                  { value: 'custom', label: 'Custom (every X days)' },
                ]} 
                placeholder="Select cadence"
                {...register('recurrence_cadence')} 
              />
              
              {(recurrenceCadence === 'custom' || recurrenceCadence === 'weekly') && (
                <Input 
                  label="Every X days" 
                  type="number" 
                  placeholder="e.g., 7, 14, 30"
                  min="1"
                  max="365"
                  {...register('recurrence_days')} 
                />
              )}
              
              <Input 
                label="Start Date" 
                type="date" 
                {...register('recurrence_start')} 
              />
              
              <Input 
                label="End Date (optional)" 
                type="date" 
                {...register('recurrence_end')} 
              />
            </>
          )}
          
          {/* Money & Budget */}
          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center gap-4">
              <Checkbox 
                label="Enable Money Tracking" 
                checked={enableMoney}
                onCheckedChange={(checked) => setValue('enable_money', checked === true)}
              />
              
              <Checkbox 
                label="Enable Tasks" 
                checked={watch('enable_tasks')}
                onCheckedChange={(checked) => setValue('enable_tasks', checked === true)}
              />
            </div>
            
            {enableMoney && (
              <div className="grid grid-cols-2 gap-3">
                <Input 
                  label="Budget Target" 
                  type="number" 
                  placeholder="0.00" 
                  {...register('budget_target')} 
                />
                <Input 
                  label="Currency" 
                  placeholder="USD" 
                  {...register('budget_currency')} 
                />
              </div>
            )}
            
            {containerType === 'recurring' && (
              <Checkbox 
                label="Carry forward unpaid amounts" 
                checked={watch('carry_forward_unpaid')}
                onCheckedChange={(checked) => setValue('carry_forward_unpaid', checked === true)}
              />
            )}
          </div>
          
          {/* Actions */}
          <div className="sticky bottom-0 bg-white pt-4 pb-2 border-t border-border mt-4">
            <div className="flex gap-3">
              <Button variant="secondary" fullWidth type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button fullWidth type="submit" loading={isPending}>
                Create
              </Button>
            </div>
          </div>
        </form>
      </div>
    </Modal>
  );
}