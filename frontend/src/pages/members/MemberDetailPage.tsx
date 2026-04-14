import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import type { WorkspaceMember } from '@/types/models';
import { useWorkspaceStore } from '@/store/workspaceStore';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const workspace = useWorkspaceStore(s => s.workspace);
  const { data, isLoading } = useQuery({ queryKey: KEYS.member(workspaceId, id!), queryFn: () => memberService.get(workspaceId, id!) });
  const { data: contribData } = useQuery({ queryKey: KEYS.contribution(workspaceId, id!), queryFn: () => memberService.getContributionSummary(workspaceId, id!) });
  const member: WorkspaceMember | undefined = (data as { member?: WorkspaceMember })?.member;
  const contrib = contribData as { total_confirmed?: number; total_pending?: number } | undefined;
  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!member) return <div className="p-6 text-center text-text-secondary">Member not found.</div>;
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <Card className="flex items-start gap-4">
        <Avatar src={member.avatar_url} name={member.display_name} size="lg" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">{member.display_name}</h1>
          {member.email && <p className="text-sm text-text-secondary">{member.email}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap"><Badge status={member.role} label={member.role} />{member.is_proxy && <Badge status="archived" label="Proxy" />}{member.engagement_level && <Badge status={member.engagement_level} />}</div>
        </div>
      </Card>
      {contrib && (
        <div className="grid grid-cols-2 gap-4">
          <Card padding="sm" className="text-center"><p className="text-xs text-text-secondary">Confirmed</p><p className="text-xl font-bold text-success mt-1"><CurrencyAmount amount={contrib.total_confirmed ?? 0} currency={workspace?.base_currency ?? 'USD'} /></p></Card>
          <Card padding="sm" className="text-center"><p className="text-xs text-text-secondary">Pending</p><p className="text-xl font-bold text-warning mt-1"><CurrencyAmount amount={contrib.total_pending ?? 0} currency={workspace?.base_currency ?? 'USD'} /></p></Card>
        </div>
      )}
    </div>
  );
}
