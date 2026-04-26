// components/members/ContributionSummaryTab.tsx
import { useQuery } from '@tanstack/react-query';
import { memberService, type ContributionSummary } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Spinner } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { Badge } from '@/components/ui/Badge';
import { formatDate } from '@/utils/date';
import { useWorkspaceStore } from '@/store/workspaceStore';

interface ContributionSummaryTabProps {
  workspaceId: string;
  memberId: string;
}

export function ContributionSummaryTab({ workspaceId, memberId }: ContributionSummaryTabProps) {
  const workspace = useWorkspaceStore(s => s.workspace);
  const currency = workspace?.base_currency ?? 'USD';

  const { data, isLoading } = useQuery({
    queryKey: KEYS.contribution(workspaceId, memberId),
    queryFn: () => memberService.getContributionSummary(workspaceId, memberId),
  });

  const summary = data as ContributionSummary | undefined;

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner /></div>;
  }

  if (!summary) {
    return (
      <div className="text-center py-8 text-text-secondary">
        No contribution data available.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Containers</p>
          <p className="text-xl font-bold text-text-primary mt-1">{summary.total_containers}</p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Contributions</p>
          <p className="text-xl font-bold text-text-primary mt-1">{summary.total_confirmed_count}</p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Total Paid</p>
          <p className="text-xl font-bold text-success mt-1">
            <CurrencyAmount amount={summary.total_paid_base_currency} currency={currency} />
          </p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Last Activity</p>
          <p className="text-sm font-medium text-text-primary mt-1">
            {summary.last_contribution_date ? formatDate(summary.last_contribution_date) : 'Never'}
          </p>
        </Card>
      </div>

      {/* Per-Container Breakdown */}
      {summary.containers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-3">Per Container Breakdown</h3>
          <div className="space-y-2">
            {summary.containers.map((container, idx) => (
              <div key={idx} className="flex items-center justify-between border border-border rounded-lg p-3">
                <div>
                  <p className="font-medium text-text-primary text-sm">{container.container_name}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-text-secondary">
                    <span>Paid: <CurrencyAmount amount={container.paid_base_amount} currency={currency} /></span>
                    {container.target_amount && (
                      <span>Target: <CurrencyAmount amount={container.target_amount} currency={container.target_currency || currency} /></span>
                    )}
                  </div>
                </div>
                <Badge status={container.status === 'paid' ? 'success' : 'warning'} label={container.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}