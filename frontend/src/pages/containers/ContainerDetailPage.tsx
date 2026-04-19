import { useState } from 'react';
import { useParams, Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { CoverPhotoUpload } from '@/components/containers/CoverPhotoUpload';
import { Pencil, Archive, Trash2, CheckCircle, Share2, RefreshCw } from 'lucide-react';
import { containerService } from '@/services/container.service';
import type { UpdateContainerPayload } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { formatDate } from '@/utils/date';
import { cn } from '@/utils/cn';
import showToast from '@/lib/toast';
import type { Container } from '@/types/models';

// ─────────────────────────────────────────────────────────────────────────────
// Edit container schema + modal
// ─────────────────────────────────────────────────────────────────────────────

const editSchema = z.object({
  name:                z.string().min(2, 'At least 2 characters').max(100),
  subtitle:            z.string().max(200).optional(),
  description:         z.string().max(2000).optional(),
  event_date:          z.string().optional(),
  event_type:          z.string().max(100).optional(),
  event_type_category: z.enum(['celebration', 'memorial', 'financial', 'logistical', 'other']).optional(),
  budget_target:       z.string().optional(),
  enable_money:        z.boolean(),
  enable_tasks:        z.boolean(),
  public_show_names:   z.boolean().default(true),
});
type EditForm = z.infer<typeof editSchema>;

const EVENT_CATEGORIES = [
  { value: 'celebration', label: 'Celebration' },
  { value: 'memorial',    label: 'Memorial'    },
  { value: 'financial',   label: 'Financial'   },
  { value: 'logistical',  label: 'Logistical'  },
  { value: 'other',       label: 'Other'       },
];

function EditContainerModal({
  open, onClose, container, workspaceId, containerId,
}: {
  open: boolean;
  onClose: () => void;
  container: any;
  workspaceId: string;
  containerId: string;
}) {
  const qc      = useQueryClient();
  const isEvent = container?.container_type === 'event';

  const { register, handleSubmit, formState: { errors } } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name:                container?.name ?? '',
      subtitle:            container?.subtitle ?? '',
      description:         container?.description ?? '',
      event_date:          container?.event_date ?? '',
      event_type:          container?.event_type ?? '',
      event_type_category: container?.event_type_category ?? 'other',
      budget_target:       container?.budget_target != null ? String(container.budget_target) : '',
      enable_money:        container?.enable_money ?? true,
      enable_tasks:        container?.enable_tasks ?? false,
      public_show_names:   container?.public_show_names ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (payload: UpdateContainerPayload) =>
      containerService.update(workspaceId, containerId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.container(workspaceId, containerId) });
      showToast.success('Container updated');
      onClose();
    },
    onError: () => showToast.error('Failed to update container'),
  });

  const onSubmit = (d: EditForm) => {
    const payload: UpdateContainerPayload = {
      name:              d.name,
      subtitle:          d.subtitle || null,
      description:       d.description || null,
      enable_money:      d.enable_money,
      enable_tasks:      d.enable_tasks,
      budget_target:     d.budget_target ? Number(d.budget_target) : null,
      public_show_names: d.public_show_names,
    };
    if (isEvent) {
      payload.event_date          = d.event_date || null;
      payload.event_type          = d.event_type || null;
      payload.event_type_category = d.event_type_category;
    }
    mutation.mutate(payload);
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit Container" size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input label="Name" placeholder="Container name" error={errors.name?.message} {...register('name')} />
          <Input label="Subtitle (optional)" placeholder="Short tagline or subtitle" {...register('subtitle')} />
          <Textarea label="Description (optional)" placeholder="What is this container about?" rows={3} {...register('description')} />

          {isEvent && (
            <>
              <Input label="Event Type (optional)" placeholder="e.g., Wedding, Birthday, Graduation" {...register('event_type')} />
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-text-secondary">Event Category</label>
                <select className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full" {...register('event_type_category')}>
                  {EVENT_CATEGORIES.map(cat => (
                    <option key={cat.value} value={cat.value}>{cat.label}</option>
                  ))}
                </select>
              </div>
              <Input label="Event Date (optional)" type="date" {...register('event_date')} />
            </>
          )}

          <Input label="Budget Target (optional)" type="number" min="0" step="0.01" placeholder="0.00" {...register('budget_target')} />

          <div className="space-y-2">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">Features</p>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input type="checkbox" className="w-4 h-4 accent-primary" {...register('enable_money')} />
              <span className="text-sm text-text-primary">Money tracking</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input type="checkbox" className="w-4 h-4 accent-primary" {...register('enable_tasks')} />
              <span className="text-sm text-text-primary">Task management</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input type="checkbox" className="w-4 h-4 accent-primary" {...register('public_show_names')} />
              <span className="text-sm text-text-primary">Show contributor names on public page</span>
            </label>
          </div>

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={onClose}>Cancel</Button>
            <Button fullWidth type="submit" loading={mutation.isPending}>Save changes</Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert to Recurring schema + modal
//
// Aligned with backend convertToRecurringSchema:
//   recurrence_cadence: enum ['monthly', 'quarterly', 'yearly', 'custom']
//   recurrence_days:    number (single integer, required when cadence = custom)
//   recurrence_start:   date string (required)
//   recurrence_end:     date string (optional)
//   carry_forward_unpaid: boolean (default false)
//   new_name:           string min 2 max 100 (optional)
// ─────────────────────────────────────────────────────────────────────────────

const convertSchema = z
  .object({
    new_name:             z.string().min(2, 'At least 2 characters').max(100).optional().or(z.literal('')),
    recurrence_cadence:   z.enum(['monthly', 'quarterly', 'yearly', 'custom'], {
      required_error: 'Cadence is required',
    }),
    recurrence_days:      z.coerce.number().int().min(1, 'Must be at least 1 day').optional(),
    recurrence_start:     z.string().min(1, 'Start date is required'),
    recurrence_end:       z.string().optional(),
    carry_forward_unpaid: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.recurrence_cadence === 'custom' && !data.recurrence_days) {
      ctx.addIssue({
        path:    ['recurrence_days'],
        message: 'Number of days is required for custom cadence',
        code:    z.ZodIssueCode.custom,
      });
    }
  });

type ConvertForm = z.infer<typeof convertSchema>;

function ConvertToRecurringModal({
  open,
  onClose,
  container,
  workspaceId,
  containerId,
  onSuccess,
}: {
  open:        boolean;
  onClose:     () => void;
  container:   Container;
  workspaceId: string;
  containerId: string;
  onSuccess:   (newContainerId: string) => void;
}) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
    reset,
  } = useForm<ConvertForm>({
    resolver: zodResolver(convertSchema),
    defaultValues: {
      new_name:             '',
      recurrence_cadence:   'monthly',
      recurrence_start:     '',
      recurrence_end:       '',
      carry_forward_unpaid: false,
    },
  });

  const cadence = watch('recurrence_cadence');

  const mutation = useMutation({
    mutationFn: (d: ConvertForm) =>
      containerService.convertToRecurring(workspaceId, containerId, {
        // Send new_name only when the user actually typed something
        ...(d.new_name ? { new_name: d.new_name } : {}),
        recurrence_cadence:   d.recurrence_cadence as any, // service type includes 'weekly' but backend doesn't — cast is safe
        recurrence_days:      d.recurrence_days,
        recurrence_start:     d.recurrence_start,
        recurrence_end:       d.recurrence_end || null,
        carry_forward_unpaid: d.carry_forward_unpaid,
      }),
    onSuccess: (res) => {
      showToast.success('Event converted to recurring pool');
      reset();
      onClose();
      onSuccess(res.new_container.id);
    },
    onError: (error: any) => {
      const message =
        error?.response?.data?.error?.message ||
        error?.message ||
        'Failed to convert container';
      showToast.error(message);
    },
  });

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Convert to Recurring Pool" size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        {/* Explanation banner */}
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 mb-4">
          <p className="text-sm font-medium text-blue-800 mb-1">What this does</p>
          <ul className="text-xs text-blue-700 list-disc list-inside space-y-1">
            <li>Creates a new <strong>recurring pool</strong> based on this event</li>
            <li>All existing participants and ledger entries stay on this event</li>
            <li>You will be taken to the new recurring container after conversion</li>
          </ul>
        </div>

        <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4">
          {/* Optional rename */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              New name <span className="text-text-secondary font-normal">(optional — defaults to "{container.name}")</span>
            </label>
            <input
              type="text"
              placeholder={container.name}
              className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
              {...register('new_name')}
            />
            {errors.new_name && (
              <p className="text-xs text-danger mt-1">{errors.new_name.message}</p>
            )}
          </div>

          {/* Cadence */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Recurrence cadence <span className="text-danger">*</span>
            </label>
            <select
              className="w-full text-sm border border-border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
              {...register('recurrence_cadence')}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
              <option value="custom">Custom (every X days)</option>
            </select>
            {errors.recurrence_cadence && (
              <p className="text-xs text-danger mt-1">{errors.recurrence_cadence.message}</p>
            )}
          </div>

          {/* Custom interval — shown only when cadence = custom */}
          {cadence === 'custom' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Every X days <span className="text-danger">*</span>
              </label>
              <input
                type="number"
                min="1"
                placeholder="e.g. 14"
                className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
                {...register('recurrence_days')}
              />
              {errors.recurrence_days && (
                <p className="text-xs text-danger mt-1">{errors.recurrence_days.message}</p>
              )}
            </div>
          )}

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Start date <span className="text-danger">*</span>
              </label>
              <input
                type="date"
                className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
                {...register('recurrence_start')}
              />
              {errors.recurrence_start && (
                <p className="text-xs text-danger mt-1">{errors.recurrence_start.message}</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                End date <span className="text-text-secondary font-normal">(optional)</span>
              </label>
              <input
                type="date"
                className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
                {...register('recurrence_end')}
              />
            </div>
          </div>

          {/* Carry forward toggle */}
          <label className="flex items-start gap-3 cursor-pointer select-none border border-border rounded-xl px-4 py-3 hover:bg-surface-secondary transition-colors">
            <input
              type="checkbox"
              className="w-4 h-4 accent-primary mt-0.5 shrink-0"
              {...register('carry_forward_unpaid')}
            />
            <div>
              <p className="text-sm font-medium text-text-primary">Carry forward unpaid amounts</p>
              <p className="text-xs text-text-secondary mt-0.5">
                Unpaid balances from a cycle roll into the next cycle's expected total
              </p>
            </div>
          </label>

          {/* Confirmation warning */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <p className="text-xs text-amber-700">
              ⚠️ This action cannot be undone. The new recurring pool will be created immediately.
            </p>
          </div>

          <div className="flex gap-3 pt-1">
            <Button variant="secondary" fullWidth type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={mutation.isPending}>
              <RefreshCw size={14} /> Convert to Recurring
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ContainerDetailPage
// ─────────────────────────────────────────────────────────────────────────────

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin  = useIsAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const qc       = useQueryClient();

  const [showEdit,      setShowEdit]      = useState(false);
  const [showComplete,  setShowComplete]  = useState(false);
  const [showConvert,   setShowConvert]   = useState(false);   // ← new
  const [completeOutcome, setCompleteOutcome] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: KEYS.container(workspaceId, id!),
    queryFn:  () => containerService.get(workspaceId, id!),
  });

  const responseData = data as {
    container?: Container;
    participant_count?: number;
    current_cycle?: any;
    current_user_participation?: any;
  };

  const container       = responseData?.container;
  const tasksEnabled    = container?.enable_tasks ?? false;
  const moneyEnabled    = container?.enable_money ?? false;
  const participantCount = responseData?.participant_count ?? 0;

  // ── Mutations ─────────────────────────────────────────────────────────────

  const archiveMutation = useMutation({
    mutationFn: () => containerService.archive(workspaceId, id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.container(workspaceId, id!) });
      qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) });
      showToast.success('Container archived');
    },
    onError: () => showToast.error('Failed to archive container'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => containerService.delete(workspaceId, id!),
    onSuccess: () => {
      showToast.success('Container deleted');
      navigate('/app/containers');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to delete container';
      showToast.error(message);
    },
  });

  const completeMutation = useMutation({
    mutationFn: () => containerService.complete(workspaceId, id!, completeOutcome || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.container(workspaceId, id!) });
      qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) });
      showToast.success('Container marked as completed');
      setShowComplete(false);
      setCompleteOutcome('');
    },
    onError: () => showToast.error('Failed to complete container'),
  });

  const generatePublicLinkMutation = useMutation({
    mutationFn: () => containerService.generatePublicLink(workspaceId, id!),
    onSuccess: (data) => {
      navigator.clipboard.writeText(data.public_url);
      showToast.success('Public link copied to clipboard');
    },
    onError: () => showToast.error('Failed to generate public link'),
  });

  const handleArchive = () => {
    if (confirm('Archive this container? It will be moved to archived status.')) archiveMutation.mutate();
  };
  const handleDelete = () => {
    if (confirm('Delete this container? This action cannot be undone.')) deleteMutation.mutate();
  };

  // ── Handle successful conversion ─────────────────────────────────────────
  const handleConvertSuccess = (newContainerId: string) => {
    // Invalidate the containers list so the new pool appears immediately
    qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) });
    // Navigate to the new recurring container
    navigate(`/app/containers/${newContainerId}`);
  };

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!container)  return <div className="p-6 text-center text-text-secondary">Container not found.</div>;

  const containerType = container.container_type;
  const isEvent       = containerType === 'event';
  const currency      = container.budget_currency || 'USD';
  const isActive      = container.status === 'active';
  const isArchived    = container.status === 'archived';

  const tabs = [
    { id: 'overview',      label: 'Overview',      path: '' },
    ...(moneyEnabled ? [{ id: 'ledger',       label: 'Ledger',       path: '/ledger'       }] : []),
    ...(tasksEnabled ? [{ id: 'tasks',        label: 'Tasks',        path: '/tasks'        }] : []),
    ...(isAdmin      ? [{ id: 'participants', label: 'Participants', path: '/participants' }] : []),
    ...(isAdmin && containerType === 'recurring'
      ? [{ id: 'cycles', label: 'Cycles', path: '/cycles' }]
      : []),
    { id: 'summary', label: 'Summary', path: '/summary' },
  ];

  const basePath = `/app/containers/${id}`;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary truncate">{container.name}</h1>
          {container.subtitle && (
            <p className="text-sm text-text-secondary mt-0.5">{container.subtitle}</p>
          )}
          {isEvent && container.event_date && (
            <p className="text-sm text-text-secondary mt-0.5">📅 {formatDate(container.event_date)}</p>
          )}
        </div>

        {isAdmin && (
          <CoverPhotoUpload
            workspaceId={workspaceId}
            containerId={id!}
            currentCoverPhotos={(container as any).cover_photos || []}
            onSuccess={() => qc.invalidateQueries({ queryKey: KEYS.container(workspaceId, id!) })}
          />
        )}

        <div className="flex items-center gap-2 flex-shrink-0">

          {/* Edit */}
          {isAdmin && (
            <button
              onClick={() => setShowEdit(true)}
              className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
              title="Edit container"
            >
              <Pencil size={15} />
            </button>
          )}

          {/* Generate public link */}
          {isAdmin && container.public_token === null && (
            <button
              onClick={() => generatePublicLinkMutation.mutate()}
              disabled={generatePublicLinkMutation.isPending}
              className="p-1.5 rounded-lg text-text-secondary hover:text-primary hover:bg-surface-secondary transition-colors disabled:opacity-50"
              title="Generate public link"
            >
              <Share2 size={15} />
            </button>
          )}

          {/* Convert to recurring — only for active event containers */}
          {isAdmin && isEvent && isActive && (
            <button
              onClick={() => setShowConvert(true)}
              className="p-1.5 rounded-lg text-text-secondary hover:text-primary hover:bg-surface-secondary transition-colors"
              title="Convert to recurring pool"
            >
              <RefreshCw size={15} />
            </button>
          )}

          {/* Mark as completed */}
          {isAdmin && isActive && (
            <button
              onClick={() => setShowComplete(true)}
              className="p-1.5 rounded-lg text-text-secondary hover:text-success hover:bg-surface-secondary transition-colors"
              title="Mark as completed"
            >
              <CheckCircle size={15} />
            </button>
          )}

          {/* Archive */}
          {isAdmin && !isArchived && (
            <button
              onClick={handleArchive}
              disabled={archiveMutation.isPending}
              className="p-1.5 rounded-lg text-text-secondary hover:text-warning hover:bg-surface-secondary transition-colors disabled:opacity-50"
              title="Archive container"
            >
              <Archive size={15} />
            </button>
          )}

          {/* Delete */}
          {isAdmin && (isArchived || !isActive) && (
            <button
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-surface-secondary transition-colors disabled:opacity-50"
              title="Delete container"
            >
              <Trash2 size={15} />
            </button>
          )}

          <Badge status={container.status} />
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {tabs.map(t => (
          <Link
            key={t.id}
            to={`${basePath}${t.path}`}
            className={cn(
              'px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors',
              location.pathname === `${basePath}${t.path}` ||
              (t.path === '' && location.pathname === basePath)
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {/* ── Overview tab ──────────────────────────────────────────────────── */}
      {(location.pathname === basePath || location.pathname === `${basePath}/`) && (
        <Card>
          {container.description && (
            <p className="text-sm text-text-secondary mb-4">{container.description}</p>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-secondary text-xs">Type</p>
              <p className="font-medium text-text-primary capitalize">{containerType || 'Not specified'}</p>
            </div>

            {isEvent && (
              <div>
                <p className="text-text-secondary text-xs">Category</p>
                <p className="font-medium text-text-primary capitalize">
                  {container.event_type_category || 'Not specified'}
                </p>
              </div>
            )}

            {isEvent && container.event_type && (
              <div>
                <p className="text-text-secondary text-xs">Event Type</p>
                <p className="font-medium text-text-primary">{container.event_type}</p>
              </div>
            )}

            {!isEvent && container.recurrence_cadence && (
              <div>
                <p className="text-text-secondary text-xs">Cadence</p>
                <p className="font-medium text-text-primary capitalize">{container.recurrence_cadence}</p>
              </div>
            )}

            <div>
              <p className="text-text-secondary text-xs">Currency</p>
              <p className="font-medium text-text-primary">{currency}</p>
            </div>

            {container.budget_target && (
              <div>
                <p className="text-text-secondary text-xs">Budget Target</p>
                <p className="font-medium text-text-primary">
                  <CurrencyAmount amount={container.budget_target} currency={currency} />
                </p>
              </div>
            )}

            <div>
              <p className="text-text-secondary text-xs">Participants</p>
              <p className="font-medium text-text-primary">{participantCount}</p>
            </div>

            <div>
              <p className="text-text-secondary text-xs">Public Page</p>
              <p className="font-medium text-text-primary">
                {container.public_token
                  ? <span className="text-success">Enabled</span>
                  : <span className="text-text-secondary">Disabled</span>}
              </p>
            </div>

            <div>
              <p className="text-text-secondary text-xs">Show Names Publicly</p>
              <p className="font-medium text-text-primary">
                {container.public_show_names ? 'Yes' : 'No'}
              </p>
            </div>

            <div>
              <p className="text-text-secondary text-xs">Created</p>
              <p className="font-medium text-text-primary">{formatDate(container.created_at)}</p>
            </div>
          </div>

          {/* Convert to recurring CTA inside overview — visible alternative to icon button */}
          {isAdmin && isEvent && isActive && (
            <div className="mt-4 pt-4 border-t border-border">
              <button
                onClick={() => setShowConvert(true)}
                className="flex items-center gap-2 text-sm text-primary hover:underline font-medium"
              >
                <RefreshCw size={14} />
                Convert this event to a recurring pool
              </button>
              <p className="text-xs text-text-secondary mt-1">
                Turn a one-time event into an ongoing recurring contribution pool.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* ── Complete Container Modal ───────────────────────────────────────── */}
      <Modal
        open={showComplete}
        onClose={() => { setShowComplete(false); setCompleteOutcome(''); }}
        title="Complete Container"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">Marking this container as completed will:</p>
          <ul className="text-sm text-text-secondary list-disc list-inside space-y-1">
            <li>Change status to "completed"</li>
            <li>Create a milestone in the timeline</li>
            <li>Notify all participants</li>
          </ul>
          <Textarea
            label="Outcome Notes (optional)"
            placeholder="What was the outcome? Any highlights?"
            rows={3}
            value={completeOutcome}
            onChange={(e) => setCompleteOutcome(e.target.value)}
          />
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth onClick={() => setShowComplete(false)}>Cancel</Button>
            <Button fullWidth onClick={() => completeMutation.mutate()} loading={completeMutation.isPending}>
              Complete Container
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Convert to Recurring Modal ─────────────────────────────────────── */}
      {isAdmin && isEvent && container && (
        <ConvertToRecurringModal
          open={showConvert}
          onClose={() => setShowConvert(false)}
          container={container}
          workspaceId={workspaceId}
          containerId={id!}
          onSuccess={handleConvertSuccess}
        />
      )}

      {/* ── Edit Container Modal ───────────────────────────────────────────── */}
      {isAdmin && (
        <EditContainerModal
          open={showEdit}
          onClose={() => setShowEdit(false)}
          container={container}
          workspaceId={workspaceId}
          containerId={id!}
        />
      )}
    </div>
  );
}
