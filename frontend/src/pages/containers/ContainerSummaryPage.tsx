import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Spinner } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import type { ContainerSummary } from '@/types/models';

export default function ContainerSummaryPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const { data, isLoading } = useQuery({ queryKey: KEYS.summary(workspaceId, id!), queryFn: () => containerService.getSummary(workspaceId, id!) });
  const s = (data as { summary?: ContainerSummary })?.summary ?? data as ContainerSummary | undefined;
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!s) return <div className="p-6 text-center text-text-secondary">No summary available.</div>;
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h2 className="text-lg font-bold text-text-primary">Summary</h2>
      <Card className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {([['Collected', s.total_confirmed], ['Expected', s.total_expected], ['Pending', s.total_pending]] as [string, number][]).map(([label, val]) => (
            <div key={label}><p className="text-xs text-text-secondary">{label}</p><p className="text-lg font-bold text-text-primary"><CurrencyAmount amount={val} currency={s.currency} /></p></div>
          ))}
          <div><p className="text-xs text-text-secondary">Participants</p><p className="text-lg font-bold text-text-primary">{s.participant_count}</p></div>
        </div>
        <ProgressBar value={s.progress_pct} showLabel />
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-green-50 rounded-lg p-2 text-center"><p className="text-green-700 font-semibold text-sm">{s.confirmed_count}</p><p className="text-green-600">Confirmed</p></div>
          <div className="bg-yellow-50 rounded-lg p-2 text-center"><p className="text-yellow-700 font-semibold text-sm">{s.pending_count}</p><p className="text-yellow-600">Pending</p></div>
        </div>
      </Card>
    </div>
  );
}
