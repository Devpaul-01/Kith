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

// Keep this in sync with the backend's SUPPORTED_CURRENCIES constant
const SUPPORTED_CURRENCIES = [
  'GBP', 'USD', 'CAD', 'EUR', 'NGN', 'KES', 'GHS', 'INR', 'ZAR',
  'JPY', 'AUD', 'CHF', 'CNY', 'MXN', 'BRL', 'SGD', 'AED', 'SAR', 'ZMW',
] as const;


const schema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name cannot exceed 100 characters'),
    subtitle: z.string().max(200, 'Subtitle cannot exceed 200 characters').optional(),
    description: z.string().max(2000, 'Description cannot exceed 2000 characters').optional(),
    container_type: z.enum(['event', 'recurring'], {
      errorMap: () => ({ message: 'Container type must be either "event" or "recurring"' }),
    }),
    enable_money: z.boolean().default(false),
    enable_tasks: z.boolean().default(false),

    // ── Event fields ──
    event_date: z.string().date().optional().nullable(),
    event_type: z.string().max(80, 'Event type cannot exceed 80 characters').optional(),
    event_type_category: z
      .enum(['celebration', 'memorial', 'financial', 'logistical', 'other'])
      .optional()
      .default('other'),

    // ── Recurring fields (nullable to match backend) ──
    recurrence_cadence: z.enum(RECURRENCE_CADENCES).optional().nullable(),
    recurrence_days: z.number().int().min(1, 'Recurrence days must be at least 1').optional().nullable(),
    recurrence_start: z.string().date().optional().nullable(),
    recurrence_end: z.string().date().optional().nullable(),
    carry_forward_unpaid: z.boolean().optional().default(false),

    // ── Money fields ──
    budget_target: z.number().positive('Budget target must be positive').optional().nullable(),
    budget_currency: z.enum(SUPPORTED_CURRENCIES).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // ── Recurring validation ──
    if (data.container_type === 'recurring') {
      if (!data.recurrence_cadence) {
        ctx.addIssue({
          path: ['recurrence_cadence'],
          message: 'Recurrence cadence is required for recurring containers',
          code: z.ZodIssueCode.custom,
        });
      }
      if (!data.recurrence_start) {
        ctx.addIssue({
          path: ['recurrence_start'],
          message: 'Start date is required for recurring containers',
          code: z.ZodIssueCode.custom,
        });
      }
    }

    // ── Event validation ──
    if (data.container_type === 'event' && !data.event_date) {
      ctx.addIssue({
        path: ['event_date'],
        message: 'Event date is required for event containers',
        code: z.ZodIssueCode.custom,
      });
    }

    // ── Money validation ──
    if (data.enable_money) {
      if (!data.budget_target) {
        ctx.addIssue({
          path: ['budget_target'],
          message: 'Budget target is required when money tracking is enabled',
          code: z.ZodIssueCode.custom,
        });
      }
      if (!data.budget_currency) {
        ctx.addIssue({
          path: ['budget_currency'],
          message: 'Budget currency is required when money tracking is enabled',
          code: z.ZodIssueCode.custom,
        });
      }
    }

    // ── Money disabled but budget fields present ──
    if (data.enable_money === false && data.budget_target != null) {
      ctx.addIssue({
        path: ['budget_target'],
        message: 'Budget target is not allowed when money tracking is disabled',
        code: z.ZodIssueCode.custom,
      });
    }

    if (data.enable_money === false && data.budget_currency != null) {
      ctx.addIssue({
        path: ['budget_currency'],
        message: 'Budget currency is not allowed when money tracking is disabled',
        code: z.ZodIssueCode.custom,
      });
    }

    // ── Recurrence end date validation ──
    if (data.recurrence_start && data.recurrence_end) {
      const start = new Date(data.recurrence_start);
      const end = new Date(data.recurrence_end);
      if (end < start) {
        ctx.addIssue({
          path: ['recurrence_end'],
          message: 'Recurrence end date must be after start date',
          code: z.ZodIssueCode.custom,
        });
      }
    }
  });

type Form = z.infer<typeof schema>;

interface Props { onClose: () => void; }

export function CreateContainerModal({ onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    shouldUnregister: true, // drop values from unmounted fields on submit
    defaultValues: {
      container_type: 'event',
      enable_money: true,
      enable_tasks: false,
      carry_forward_unpaid: false,
      budget_currency: 'USD',
    },
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

  const onInvalid = (formErrors: typeof errors) => {
    console.warn('Validation failed:', formErrors);
    showToast.error('Please fix the highlighted fields.');
  };

  const errorEntries = Object.entries(errors);

  const numberFieldProps = {
    setValueAs: (v: string) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  };

  return (
    <Modal open onClose={onClose} title="Create Event or Pool" size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        <form onSubmit={handleSubmit((d) => mutate(d), onInvalid)} className="space-y-4">
          {errorEntries.length > 0 && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              <p className="font-medium mb-1">Please fix the following:</p>
              <ul className="list-disc pl-5 space-y-0.5">
                {errorEntries.map(([field, err]) => (
                  <li key={field}>{(err as any)?.message || `${field} is invalid`}</li>
                ))}
              </ul>
            </div>
          )}

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
            error={errors.description?.message}
            {...register('description')}
          />

          {/* Event-specific fields */}
          {containerType === 'event' && (
            <>
              <Input
                label="Event Type"
                placeholder="e.g., Wedding, Birthday, Graduation, Holiday"
                error={errors.event_type?.message}
                {...register('event_type')}
              />

              <Select
                label="Category"
                options={EVENT_CATEGORIES.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))}
                placeholder="Select category"
                error={errors.event_type_category?.message}
                {...register('event_type_category')}
              />

              <Input
                label="Event Date"
                type="date"
                error={errors.event_date?.message}
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
                error={errors.recurrence_cadence?.message}
                {...register('recurrence_cadence')}
              />

              {(recurrenceCadence === 'custom' || recurrenceCadence === 'weekly') && (
                <Input
                  label="Every X days"
                  type="number"
                  placeholder="e.g., 7, 14, 30"
                  min="1"
                  max="365"
                  error={errors.recurrence_days?.message}
                  {...register('recurrence_days', numberFieldProps)}
                />
              )}

              <Input
                label="Start Date"
                type="date"
                error={errors.recurrence_start?.message}
                {...register('recurrence_start')}
              />

              <Input
                label="End Date (optional)"
                type="date"
                error={errors.recurrence_end?.message}
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
                onCheckedChange={(checked) => {
                  const isEnabled = checked === true;
                  setValue('enable_money', isEnabled, { shouldValidate: true });
                  if (!isEnabled) {
                    setValue('budget_target', null, { shouldValidate: true });
                    setValue('budget_currency', null, { shouldValidate: true });
                  } else if (!watch('budget_currency')) {
                    setValue('budget_currency', 'USD');
                  }
                }}
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
                  step="0.01"
                  placeholder="0.00"
                  error={errors.budget_target?.message}
                  {...register('budget_target', numberFieldProps)}
                />
                <Select
                  label="Currency"
                  options={SUPPORTED_CURRENCIES.map(c => ({ value: c, label: c }))}
                  placeholder="Select currency"
                  error={errors.budget_currency?.message}
                  {...register('budget_currency')}
                />
              </div>
            )}

            {containerType === 'recurring' && enableMoney && (
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