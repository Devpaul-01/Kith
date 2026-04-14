import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { formatDate } from '@/utils/date';
import { formatCurrency } from '@/utils/currency';
import type { Cycle } from '@/types/models';
import { useWorkspaceStore } from '@/store/workspaceStore';

export default function ContainerCyclesPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const workspace = useWorkspaceStore(s => s.workspace);
  const { data, isLoading } = useQuery({ queryKey: KEYS.cycles(workspaceId, id!), queryFn: () => containerService.listCycles(workspaceId, id!) });
  const cycles: Cycle[] = (data as { cycles?: Cycle[] })?.cycles ?? [];
  const currency = workspace?.base_currency ?? 'USD';
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <h2 className="text-lg font-bold text-text-primary">Cycles</h2>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      <div className="space-y-3">
        {cycles.map(c => (
          <div key={c.id} className="bg-white border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between"><p className="font-medium text-text-primary">Cycle {c.cycle_number}</p><Badge status={c.status} /></div>
            <div className="text-xs text-text-secondary flex gap-4"><span>Start: {formatDate(c.start_date)}</span><span>End: {formatDate(c.end_date)}</span></div>
            <ProgressBar value={c.total_collected} max={c.total_expected || 100} />
            <div className="flex justify-between text-xs text-text-secondary"><span>{formatCurrency(c.total_collected, currency)} collected</span><span>of {formatCurrency(c.total_expected, currency)}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
