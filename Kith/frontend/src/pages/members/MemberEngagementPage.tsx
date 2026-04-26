// pages/MemberEngagementPage.tsx
import { useQuery } from '@tanstack/react-query';
import { memberService, type EngagementMember } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useNavigate } from 'react-router-dom';
import { BarChart3, Users } from 'lucide-react';

const ENGAGEMENT_COLORS = {
  active: 'bg-green-100 text-green-700',
  quiet: 'bg-yellow-100 text-yellow-700',
  inactive: 'bg-gray-100 text-gray-500',
};

export default function MemberEngagementPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.engagement(workspaceId),
    queryFn: () => memberService.getEngagement(workspaceId),
    enabled: isAdmin,
  });

  const members: EngagementMember[] = (data as { members?: EngagementMember[] })?.members ?? [];

  // Calculate stats
  const activeCount = members.filter(m => m.engagement_level === 'active').length;
  const quietCount = members.filter(m => m.engagement_level === 'quiet').length;
  const inactiveCount = members.filter(m => m.engagement_level === 'inactive').length;
  const totalConfirmed = members.reduce((sum, m) => sum + m.confirmed_contributions_count, 0);
  const totalPending = members.reduce((sum, m) => sum + m.pending_contributions_count, 0);

  if (!isAdmin) {
    return (
      <div className="p-6 text-center text-text-secondary">
        Only admins can view engagement reports.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Member Engagement</h1>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <BarChart3 size={14} /> Based on last 90 days of activity
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Total Members</p>
          <p className="text-xl font-bold text-text-primary">{members.length}</p>
        </Card>
        <Card padding="sm" className="text-center bg-green-50">
          <p className="text-xs text-green-600">Active</p>
          <p className="text-xl font-bold text-green-700">{activeCount}</p>
        </Card>
        <Card padding="sm" className="text-center bg-yellow-50">
          <p className="text-xs text-yellow-600">Quiet</p>
          <p className="text-xl font-bold text-yellow-700">{quietCount}</p>
        </Card>
        <Card padding="sm" className="text-center bg-gray-50">
          <p className="text-xs text-gray-500">Inactive</p>
          <p className="text-xl font-bold text-gray-500">{inactiveCount}</p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-xs text-text-secondary">Contributions</p>
          <p className="text-sm font-medium text-text-primary">
            {totalConfirmed} confirmed / {totalPending} pending
          </p>
        </Card>
      </div>

      {/* Members Table */}
      {members.length === 0 ? (
        <EmptyState
          icon={<Users size={36} />}
          title="No members found"
          description="Add members to see engagement data."
        />
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-alt border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-secondary">Member</th>
                  <th className="text-left px-4 py-3 font-medium text-text-secondary">Engagement</th>
                  <th className="text-left px-4 py-3 font-medium text-text-secondary">Last Activity</th>
                  <th className="text-left px-4 py-3 font-medium text-text-secondary">Contributions</th>
                  <th className="text-left px-4 py-3 font-medium text-text-secondary">Pending</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr
                    key={member.member_id}
                    onClick={() => navigate(`/app/members/${member.member_id}`)}
                    className="border-b border-border last:border-b-0 hover:bg-surface-alt cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-text-primary">{member.display_name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${ENGAGEMENT_COLORS[member.engagement_level]}`}>
                        {member.engagement_level}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {member.last_activity ? new Date(member.last_activity).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="px-4 py-3 text-text-primary">
                      {member.confirmed_contributions_count}
                    </td>
                    <td className="px-4 py-3 text-warning">
                      {member.pending_contributions_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}