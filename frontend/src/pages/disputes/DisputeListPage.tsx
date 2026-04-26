import { useQuery } from '@tanstack/react-query';
import { disputeService } from '@/services/dispute.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Flag } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { timeAgo } from '@/utils/date';
import type { Dispute } from '@/types/models';

export default function DisputeListPage() {
  const { workspaceId } = useWorkspace();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: KEYS.disputes(workspaceId), queryFn: () => disputeService.list(workspaceId), staleTime: 60_000 });
  const disputes: Dispute[] = (data as { disputes?: Dispute[] })?.disputes ?? [];
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Disputes</h1>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && disputes.length === 0 && <EmptyState icon={<Flag size={36} />} title="No disputes" description="Everything looks good." />}
      <div className="space-y-3">
        {disputes.map(d => (
          <div key={d.id} onClick={() => nav(`/app/disputes/${d.id}`)} className="bg-white border border-border rounded-xl p-4 cursor-pointer hover:border-primary transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0"><p className="font-medium text-text-primary text-sm">Raised by: {d.raised_by_name}</p><p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{d.reason}</p><p className="text-xs text-text-secondary mt-1">{timeAgo(d.created_at)}</p></div>
              <Badge status={d.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
