// components/members/ProfileHistoryTab.tsx
import { useQuery } from '@tanstack/react-query';
import { memberService, type ProfileHistoryEntry } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Spinner } from '@/components/ui/Spinner';
import { formatDate } from '@/utils/date';

interface ProfileHistoryTabProps {
  workspaceId: string;
  memberId: string;
}

const FIELD_NAME_MAP: Record<string, string> = {
  display_name: 'Display Name',
  role: 'Role',
  is_proxy: 'Proxy Status',
  proxy_managed_by: 'Managed By',
  is_active: 'Status',
  relationship_to_head: 'Relationship to Head',
  relationship_category: 'Relationship Category',
  date_of_birth: 'Date of Birth',
  admin_notes: 'Admin Notes',
};

export function ProfileHistoryTab({ workspaceId, memberId }: ProfileHistoryTabProps) {
  const { data, isLoading } = useQuery({
    queryKey: KEYS.profileHistory(workspaceId, memberId),
    queryFn: () => memberService.getProfileHistory(workspaceId, memberId),
  });

  const history: ProfileHistoryEntry[] = (data as { history?: ProfileHistoryEntry[] })?.history ?? [];

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner /></div>;
  }

  if (history.length === 0) {
    return (
      <div className="text-center py-8 text-text-secondary">
        No profile changes recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {history.map((entry) => (
        <div key={entry.id} className="border border-border rounded-lg p-3 text-sm">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="font-medium text-text-primary">
              {FIELD_NAME_MAP[entry.field_name] || entry.field_name}
            </span>
            <span className="text-xs text-text-secondary">
              {formatDate(entry.changed_at)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className="text-text-secondary">Changed by:</span>
            <span className="font-medium text-text-primary">{entry.changed_by_name || 'System'}</span>
            <span className="text-text-secondary">({entry.change_source})</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-text-secondary">Old value:</span>
              <p className="text-text-primary break-words">{entry.old_value || '—'}</p>
            </div>
            <div>
              <span className="text-text-secondary">New value:</span>
              <p className="text-text-primary break-words">{entry.new_value || '—'}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}