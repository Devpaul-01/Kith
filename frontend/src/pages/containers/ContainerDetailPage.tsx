import { useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil } from 'lucide-react';
import { containerService } from '@/services/container.service';
import type { UpdateContainerPayload } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { ProgressBar } from '@/components/ui/ProgressBar';
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

// ── Edit form schema ──────────────────────────────────────────────────────────
const editSchema = z.object({
  name:          z.string().min(2, 'At least 2 characters').max(100),
  subtitle:      z.string().max(200).optional(),
  description:   z.string().max(2000).optional(),
  event_date:    z.string().optional(),
  budget_target: z.string().optional(),
  enable_money:  z.boolean(),
  enable_tasks:  z.boolean(),
});
type EditForm = z.infer<typeof editSchema>;

// ── EditContainerModal ────────────────────────────────────────────────────────
function EditContainerModal({
  open,
  onClose,
  container,
  workspaceId,
  containerId,
}: {
  open: boolean;
  onClose: () => void;
  container: any;
  workspaceId: string;
  containerId: string;
}) {
  const qc = useQueryClient();

  const isEvent = container?.container_type === 'event' || container?.type === 'event';

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name:          container?.name ?? '',
      subtitle:      container?.subtitle ?? '',
      description:   container?.description ?? '',
      event_date:    container?.event_date ?? '',
      budget_target: container?.budget_target != null ? String(container.budget_target) : '',
      enable_money:  container?.enable_money ?? true,
      enable_tasks:  container?.enable_tasks ?? false,
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
      name:        d.name,
      subtitle:    d.subtitle || null,
      description: d.description || null,
      enable_money: d.enable_money,
      enable_tasks: d.enable_tasks,
      budget_target: d.budget_target ? Number(d.budget_target) : null,
    };
    if (isEvent) {
      payload.event_date = d.event_date || null;
    }
    mutation.mutate(payload);
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit Container">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input label="Name" placeholder="Container name" error={errors.name?.message} {...register('name')} />
        <Input label="Subtitle (optional)" placeholder="Short tagline or subtitle" {...register('subtitle')} />
        <Textarea label="Description (optional)" placeholder="What is this container about?" rows={3} {...register('description')} />
        
        {isEvent && (
          <Input label="Event date (optional)" type="date" {...register('event_date')} />
        )}
        
        <Input label="Budget target (optional)" type="number" min="0" step="0.01" placeholder="0.00" {...register('budget_target')} />
        
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
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth type="button" onClick={onClose}>Cancel</Button>
          <Button fullWidth type="submit" loading={mutation.isPending}>Save changes</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── ContainerDetailPage ───────────────────────────────────────────────────────
export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const [showEdit, setShowEdit] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: KEYS.container(workspaceId, id!),
    queryFn: () => containerService.get(workspaceId, id!),
  });

  // Log the actual response for debugging
  console.log('🔍 Container API Response:', data);

  const responseData = data as {
    container?: Container;
    tasks_enabled?: boolean;
    money_enabled?: boolean;
    participant_count?: number;
    current_cycle?: any;
    current_user_participation?: any;
  };

  const container = responseData?.container;
  const tasksEnabled = responseData?.tasks_enabled ?? container?.enable_tasks ?? false;
  const moneyEnabled = responseData?.money_enabled ?? container?.enable_money ?? false;
  const participantCount = responseData?.participant_count ?? 0;

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!container) return <div className="p-6 text-center text-text-secondary">Container not found.</div>;

  const containerType = container.container_type;
  const isEvent = containerType === 'event';
  
  // Get the currency - try multiple possible field names
  const currency = container.budget_currency || (container as any).base_currency || 'USD';
  
  // For progress, we need to fetch summary data or calculate from available data
  // For now, we'll show a simplified view without progress if not available

  const tabs = [
    { id: 'overview', label: 'Overview', path: '' },
    ...(moneyEnabled ? [{ id: 'ledger', label: 'Ledger', path: '/ledger' }] : []),
    ...(tasksEnabled ? [{ id: 'tasks', label: 'Tasks', path: '/tasks' }] : []),
    ...(isAdmin ? [{ id: 'participants', label: 'Participants', path: '/participants' }] : []),
    ...(isAdmin && containerType === 'recurring' ? [{ id: 'cycles', label: 'Cycles', path: '/cycles' }] : []),
    { id: 'summary', label: 'Summary', path: '/summary' },
  ];

  const basePath = `/app/containers/${id}`;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
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

        <div className="flex items-center gap-2 flex-shrink-0">
          {isAdmin && (
            <button
              onClick={() => setShowEdit(true)}
              className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
              title="Edit container"
            >
              <Pencil size={15} />
            </button>
          )}
          <Badge status={container.status} />
        </div>
      </div>

      {/* ── Progress card - Only show if budget target exists and we have summary data ── */}
      {/* For now, we'll skip the progress card here since it needs summary data */}
      {/* The Summary tab will show full progress details */}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
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

      {/* ── Overview tab ─────────────────────────────────────────────────── */}
      {(location.pathname === basePath || location.pathname === `${basePath}/`) && (
        <Card>
          {container.description && (
            <p className="text-sm text-text-secondary mb-4">{container.description}</p>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            {/* Type */}
            <div>
              <p className="text-text-secondary text-xs">Type</p>
              <p className="font-medium text-text-primary capitalize">
                {containerType || 'Not specified'}
              </p>
            </div>

            {/* Category - only for events */}
            {isEvent && (
              <div>
                <p className="text-text-secondary text-xs">Category</p>
                <p className="font-medium text-text-primary capitalize">
                  {container.event_type_category || 'Not specified'}
                </p>
              </div>
            )}

            {/* Recurring cadence - only for recurring */}
            {!isEvent && container.recurrence_cadence && (
              <div>
                <p className="text-text-secondary text-xs">Cadence</p>
                <p className="font-medium text-text-primary capitalize">
                  {container.recurrence_cadence}
                </p>
              </div>
            )}

            {/* Currency */}
            <div>
              <p className="text-text-secondary text-xs">Currency</p>
              <p className="font-medium text-text-primary">{currency}</p>
            </div>

            {/* Budget Target */}
            {container.budget_target && (
              <div>
                <p className="text-text-secondary text-xs">Budget Target</p>
                <p className="font-medium text-text-primary">
                  <CurrencyAmount amount={container.budget_target} currency={currency} />
                </p>
              </div>
            )}

            {/* Participants */}
            <div>
              <p className="text-text-secondary text-xs">Participants</p>
              <p className="font-medium text-text-primary">{participantCount}</p>
            </div>

            {/* Created At */}
            <div>
              <p className="text-text-secondary text-xs">Created</p>
              <p className="font-medium text-text-primary">{formatDate(container.created_at)}</p>
            </div>
          </div>
        </Card>
      )}

      {/* ── Edit Container Modal ─────────────────────────────────────────── */}
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