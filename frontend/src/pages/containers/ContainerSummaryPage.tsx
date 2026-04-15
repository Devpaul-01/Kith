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
  const { data, isLoading } = useQuery({ 
    queryKey: KEYS.summary(workspaceId, id!), 
    queryFn: () => containerService.getSummary(workspaceId, id!) 
  });
  const s = (data as { summary?: ContainerSummary })?.summary ?? data as ContainerSummary | undefined;
  
  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!s) return <div className="p-6 text-center text-text-secondary">No summary available.</div>;
  
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h2 className="text-lg font-bold text-text-primary">Summary</h2>
      <Card className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {/* Collected amount - only show if defined */}
          {s.total_confirmed !== undefined && s.total_confirmed !== null && (
            <div>
              <p className="text-xs text-text-secondary">Collected</p>
              <p className="text-lg font-bold text-text-primary">
                <CurrencyAmount amount={s.total_confirmed} currency={s.currency} />
              </p>
            </div>
          )}
          
          {/* Expected amount - only show if defined */}
          {s.total_expected !== undefined && s.total_expected !== null && (
            <div>
              <p className="text-xs text-text-secondary">Expected</p>
              <p className="text-lg font-bold text-text-primary">
                <CurrencyAmount amount={s.total_expected} currency={s.currency} />
              </p>
            </div>
          )}
          
          {/* Pending amount - only show if defined */}
          {s.total_pending !== undefined && s.total_pending !== null && (
            <div>
              <p className="text-xs text-text-secondary">Pending</p>
              <p className="text-lg font-bold text-text-primary">
                <CurrencyAmount amount={s.total_pending} currency={s.currency} />
              </p>
            </div>
          )}
          
          {/* Participants - only show if defined */}
          {s.participant_count !== undefined && s.participant_count !== null && (
            <div>
              <p className="text-xs text-text-secondary">Participants</p>
              <p className="text-lg font-bold text-text-primary">{s.participant_count}</p>
            </div>
          )}
        </div>
        
        {/* Progress bar - only show if progress_pct is defined */}
        {s.progress_pct !== undefined && s.progress_pct !== null && (
          <ProgressBar value={s.progress_pct} showLabel />
        )}
        
        {/* Summary stats - only show if counts are defined */}
        {(s.confirmed_count !== undefined && s.confirmed_count !== null) || 
         (s.pending_count !== undefined && s.pending_count !== null) ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {s.confirmed_count !== undefined && s.confirmed_count !== null && (
              <div className="bg-green-50 rounded-lg p-2 text-center">
                <p className="text-green-700 font-semibold text-sm">{s.confirmed_count}</p>
                <p className="text-green-600">Confirmed</p>
              </div>
            )}
            {s.pending_count !== undefined && s.pending_count !== null && (
              <div className="bg-yellow-50 rounded-lg p-2 text-center">
                <p className="text-yellow-700 font-semibold text-sm">{s.pending_count}</p>
                <p className="text-yellow-600">Pending</p>
              </div>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}