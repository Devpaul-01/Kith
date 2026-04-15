import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { formatDate } from '@/utils/date';
import { cn } from '@/utils/cn';
import type { Container } from '@/types/models';
import { useLocation } from 'react-router-dom';

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const location = useLocation();
  // In ContainerDetailPage.tsx
const { data, isLoading } = useQuery({ 
  queryKey: KEYS.container(workspaceId, id!), 
  queryFn: () => containerService.get(workspaceId, id!) 
});

// Extract all fields from the response
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
const participantCount = responseData?.participant_count ?? container?.participant_count ?? 0;
  

  const tabs = [
    { id: 'overview',      label: 'Overview',     path: '' },
    ...(isAdmin && container.money_enabled?[{ id: 'ledger',        label: 'Ledger',        path: '/ledger' }]: []),
    ...(isAdmin && container.tasks_enabled? [{ id: 'tasks',         label: 'Tasks',         path: '/tasks' }]: []),
    ...(isAdmin ? [{ id: 'participants', label: 'Participants', path: '/participants' }] : []),
    ...(isAdmin && container?.type === 'recurring' ? [{ id: 'cycles', label: 'Cycles', path: '/cycles' }] : []),
    { id: 'summary',       label: 'Summary',       path: '/summary' },
  ];

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!container) return <div className="p-6 text-center text-text-secondary">Container not found.</div>;

  const basePath = `/app/containers/${id}`;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary truncate">{container.name}</h1>
          {container.event_date && <p className="text-sm text-text-secondary mt-0.5">📅 {formatDate(container.event_date)}</p>}
        </div>
        <Badge status={container.status} />
      </div>
      {container.budget_target && (
        <Card padding="sm">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-text-secondary">Progress</span>
            <span className="font-bold text-text-primary">
              <CurrencyAmount amount={container.total_confirmed ?? 0} currency={container.base_currency} />
              {' '}<span className="font-normal text-text-secondary">of <CurrencyAmount amount={container.budget_target} currency={container.base_currency} /></span>
            </span>
          </div>
          <ProgressBar value={container.progress_pct ?? 0} showLabel />
        </Card>
      )}
      <div className="flex gap-0 border-b border-border overflow-x-auto">
        {tabs.map(t => (
          <Link key={t.id} to={`${basePath}${t.path}`} className={cn('px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors', location.pathname === `${basePath}${t.path}` || (t.path === '' && location.pathname === basePath) ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary')}>
            {t.label}
          </Link>
        ))}
      </div>
      {(location.pathname === basePath || location.pathname === `${basePath}/`) && (
        <Card>
          {container.description && <p className="text-sm text-text-secondary mb-4">{container.description}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><p className="text-text-secondary text-xs">Type</p><p className="font-medium text-text-primary capitalize">{container.type}</p></div>
            {container.category && <div><p className="text-text-secondary text-xs">Category</p><p className="font-medium text-text-primary capitalize">{container.category}</p></div>}
            <div><p className="text-text-secondary text-xs">Currency</p><p className="font-medium text-text-primary">{container.base_currency}</p></div>
            <div><p className="text-text-secondary text-xs">Participants</p><p className="font-medium text-text-primary">{container.participant_count ?? 0}</p></div>
          </div>
        </Card>
      )}
    </div>
  );
}
