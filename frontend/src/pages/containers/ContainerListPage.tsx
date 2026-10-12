import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { useNavigate } from 'react-router-dom';
import { Plus, Box, Search, Trash2, RotateCcw } from 'lucide-react';
import { formatDate } from '@/utils/date';
import { formatCurrency } from '@/utils/currency';
import type { Container } from '@/types/models';
import { CreateContainerModal } from './CreateContainerModal';
import showToast from '@/lib/toast';

export default function ContainerListPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: showDeleted
      ? [...KEYS.containers(workspaceId), 'deleted']
      : KEYS.containers(workspaceId),
    queryFn: () =>
      containerService.list(workspaceId, showDeleted ? { include_deleted: 'true' } : undefined),
    staleTime: 120_000,
    enabled: !showDeleted || isAdmin,
  });
  const containers: Container[] = (data as { containers?: Container[] })?.containers ?? [];
  const filtered = containers.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));

  const restoreMutation = useMutation({
    mutationFn: (containerId: string) => containerService.restore(workspaceId, containerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.containers(workspaceId) });
      showToast.success('Container restored');
    },
    onError: () => showToast.error('Failed to restore container'),
  });

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Events & Pools</h1>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={() => setShowDeleted(s => !s)}
              className="text-xs text-text-secondary hover:text-primary flex items-center gap-1 px-2 py-1.5 rounded-lg border border-border transition-colors"
            >
              <Trash2 size={13} /> {showDeleted ? 'Back to events' : 'Recently deleted'}
            </button>
          )}
          {isAdmin && !showDeleted && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />New
            </Button>
          )}
        </div>
      </div>
      {!showDeleted && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary bg-white"
            placeholder="Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}
      {showDeleted && (
        <p className="text-xs text-text-secondary">
          Deleted events and pools are kept here until restored. Restoring brings back the container and its ledger/task history.
        </p>
      )}
      {isLoading && (
        <div className="grid sm:grid-cols-2 gap-4">
          {Array(4).fill(0).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}
      {!isLoading && filtered.length === 0 && (
        <EmptyState
          icon={<Box size={40} />}
          title={showDeleted ? 'Nothing deleted' : 'No events yet'}
          description={showDeleted ? 'Deleted events and pools will show up here.' : undefined}
          action={
            isAdmin && !showDeleted
              ? <Button size="sm" onClick={() => setShowCreate(true)}><Plus size={14} />Create Event</Button>
              : undefined
          }
        />
      )}
      <div className="grid sm:grid-cols-2 gap-4">
        {filtered.map(c => {
  const totalConfirmed = (c as any).total_confirmed_base ?? 0;
  const progressPct = c.budget_target && totalConfirmed 
    ? Math.round((totalConfirmed / c.budget_target) * 100)
    : 0;

  if (showDeleted) {
    return (
      <Card key={c.id} className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-text-primary truncate">{c.name}</p>
            {c.deleted_at && (
              <p className="text-xs text-text-secondary mt-0.5">
                Deleted {formatDate(c.deleted_at)}
              </p>
            )}
          </div>
          <Badge status={c.status} />
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => restoreMutation.mutate(c.id)}
          loading={restoreMutation.isPending}
        >
          <RotateCcw size={13} /> Restore
        </Button>
      </Card>
    );
  }

  return (
    <Card key={c.id} hover onClick={() => nav(`/app/containers/${c.id}`)} className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-text-primary truncate">{c.name}</p>
          {c.event_date && (
            <p className="text-xs text-text-secondary mt-0.5">📅 {formatDate(c.event_date)}</p>
          )}
        </div>
        <Badge status={c.status} />
      </div>
      {c.budget_target && (
        <div className="space-y-1.5">
          <ProgressBar value={progressPct} />
          <div className="flex justify-between text-xs text-text-secondary">
            <span>{formatCurrency(totalConfirmed, c.budget_currency ?? 'USD')} collected</span>
            <span>{progressPct}%</span>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs bg-slate-100 text-text-secondary px-2 py-0.5 rounded-full capitalize">
          {c.container_type}
        </span>
        {c.event_type_category && (
          <span className="text-xs bg-slate-100 text-text-secondary px-2 py-0.5 rounded-full capitalize">
            {c.event_type_category}
          </span>
        )}
        <span className="text-xs text-text-secondary ml-auto">
          {c.participant_count ?? 0} participants
        </span>
      </div>
    </Card>
  );
})}
      </div>
      {showCreate && <CreateContainerModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}
