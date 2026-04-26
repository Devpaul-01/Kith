import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Spinner } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { useIsAdmin } from '@/hooks/useIsAdmin';

// Type for the API response from getSummary
interface SummaryParticipant {
  member_id: string;
  display_name: string;
  is_proxy?: boolean;
  role: string;
  status: 'paid' | 'partial' | 'overdue' | 'pending' | 'no_target';
  // For admins only (extra fields)
  current_target?: {
    amount: number;
    currency: string;
    due_date: string | null;
  };
  confirmed_paid_base?: number;
  pending_paid_base?: number;
  outstanding_base?: number;
}

interface SummaryApiResponse {
  container: {
    id: string;
    name: string;
    status: string;
    budget_target: number | null;
    budget_currency: string | null;
    enable_money: boolean;
  };
  total_expected_base: number;
  total_confirmed_base: number;
  total_pending_base: number;
  progress_pct: number | null;
  participants: SummaryParticipant[];
}

export default function ContainerSummaryPage() {
  const { id: containerId } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();

  const { data, isLoading, error } = useQuery({
    queryKey: KEYS.summary(workspaceId, containerId!),
    queryFn: () => containerService.getSummary(workspaceId, containerId!),
    enabled: !!containerId && !!workspaceId,
  });

  const raw = data as SummaryApiResponse | undefined;

  // Debug logging
  console.log('Summary API Response:', raw);
  console.log('Participants:', raw?.participants);
  console.log('Total expected:', raw?.total_expected_base);
  console.log('Total confirmed:', raw?.total_confirmed_base);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive">
        Failed to load summary. Please try again.
      </div>
    );
  }

  if (!raw || !raw.container) {
    return (
      <div className="p-6 text-center text-text-secondary">
        No summary data available.
      </div>
    );
  }

  const { container, participants = [] } = raw;
  const currency = container.budget_currency ?? 'USD';
  const hasMoneyTracking = container.enable_money;

  // Calculate participant status counts
  const confirmedCount = participants.filter(p => p.status === 'paid').length;
  const pendingCount = participants.filter(p => 
    ['pending', 'partial', 'overdue'].includes(p.status)
  ).length;
  const noTargetCount = participants.filter(p => p.status === 'no_target').length;
  const participantCount = participants.length;

  // Calculate totals from participants (more accurate than raw totals for display)
  const totalExpectedFromParticipants = participants.reduce(
    (sum, p) => sum + (p.current_target?.amount || 0), 
    0
  );
  
  const totalConfirmedFromParticipants = participants.reduce(
    (sum, p) => sum + (p.confirmed_paid_base || 0), 
    0
  );
  
  const totalPendingFromParticipants = participants.reduce(
    (sum, p) => sum + (p.pending_paid_base || 0), 
    0
  );

  // Use participant-calculated values if available, otherwise use raw totals
  const totalExpected = totalExpectedFromParticipants > 0 
    ? totalExpectedFromParticipants 
    : raw.total_expected_base;
  
  const totalConfirmed = totalConfirmedFromParticipants > 0 
    ? totalConfirmedFromParticipants 
    : raw.total_confirmed_base;
  
  const totalPending = totalPendingFromParticipants > 0 
    ? totalPendingFromParticipants 
    : raw.total_pending_base;

  // Calculate progress percentage
  let progressPct = raw.progress_pct;
  if (progressPct === null && totalExpected > 0) {
    progressPct = Math.round((totalConfirmed / totalExpected) * 100);
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Summary</h2>
        {!hasMoneyTracking && (
          <span className="text-xs text-text-secondary bg-surface px-2 py-1 rounded-full">
            Money tracking disabled
          </span>
        )}
      </div>

      <Card className="space-y-4">
        {/* Money grid - only show if money tracking is enabled */}
        {hasMoneyTracking ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-xs text-green-600 font-medium">Confirmed</p>
                <p className="text-xl font-bold text-green-700">
                  <CurrencyAmount amount={totalConfirmed} currency={currency} />
                </p>
              </div>

              <div className="bg-yellow-50 rounded-lg p-3">
                <p className="text-xs text-yellow-600 font-medium">Pending</p>
                <p className="text-xl font-bold text-yellow-700">
                  <CurrencyAmount amount={totalPending} currency={currency} />
                </p>
              </div>

              <div className="bg-blue-50 rounded-lg p-3">
                <p className="text-xs text-blue-600 font-medium">Expected</p>
                <p className="text-xl font-bold text-blue-700">
                  <CurrencyAmount amount={totalExpected} currency={currency} />
                </p>
              </div>

              <div className="bg-purple-50 rounded-lg p-3">
                <p className="text-xs text-purple-600 font-medium">Participants</p>
                <p className="text-xl font-bold text-purple-700">{participantCount}</p>
              </div>
            </div>

            {/* Progress bar */}
            {progressPct !== null && (
              <div className="pt-2">
                <ProgressBar value={progressPct} showLabel />
              </div>
            )}
          </>
        ) : (
          // Show simple participant count when money tracking is disabled
          <div className="text-center py-6">
            <p className="text-text-secondary">Money tracking is not enabled for this container.</p>
            <p className="text-sm text-text-secondary mt-1">
              {participantCount} participant{participantCount !== 1 ? 's' : ''} in this container.
            </p>
          </div>
        )}

        {/* Status breakdown - only show if there are participants */}
        {participantCount > 0 && hasMoneyTracking && (
          <div className="grid grid-cols-3 gap-2 text-xs pt-2">
            <div className="bg-green-100 rounded-lg p-2 text-center">
              <p className="text-green-800 font-bold text-lg">{confirmedCount}</p>
              <p className="text-green-700 text-xs">Confirmed</p>
            </div>
            <div className="bg-yellow-100 rounded-lg p-2 text-center">
              <p className="text-yellow-800 font-bold text-lg">{pendingCount}</p>
              <p className="text-yellow-700 text-xs">Pending</p>
            </div>
            <div className="bg-gray-100 rounded-lg p-2 text-center">
              <p className="text-gray-800 font-bold text-lg">{noTargetCount}</p>
              <p className="text-gray-700 text-xs">No target</p>
            </div>
          </div>
        )}

        {/* Participant list for admins */}
        {isAdmin && participants.length > 0 && hasMoneyTracking && (
          <div className="mt-4 pt-4 border-t border-border">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Contributors</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {participants.map((p) => (
                <div key={p.member_id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary">{p.display_name}</span>
                    {p.is_proxy && (
                      <span className="text-xs text-text-secondary bg-surface px-1.5 py-0.5 rounded">
                        Proxy
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-secondary">
                      {p.current_target ? (
                        <CurrencyAmount amount={p.current_target.amount} currency={p.current_target.currency} />
                      ) : (
                        'No target'
                      )}
                    </span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      p.status === 'paid' ? 'bg-green-100 text-green-700' :
                      p.status === 'partial' ? 'bg-yellow-100 text-yellow-700' :
                      p.status === 'overdue' ? 'bg-red-100 text-red-700' :
                      p.status === 'pending' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-500'
                    }`}>
                      {p.status === 'paid' ? '✓ Paid' :
                       p.status === 'partial' ? 'Partial' :
                       p.status === 'overdue' ? 'Overdue' :
                       p.status === 'pending' ? 'Pending' : 'No target'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}