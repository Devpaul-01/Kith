import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useDebounce } from '@/hooks/useDebounce';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useNavigate } from 'react-router-dom';
import { Search, Users, UserPlus } from 'lucide-react';
import { InviteModal } from './InviteModal';
import type { WorkspaceMember } from '@/types/models';

export default function MemberListPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const dSearch = useDebounce(search, 300);
  const { data, isLoading } = useQuery({ queryKey: [...KEYS.members(workspaceId), { search: dSearch }], queryFn: () => memberService.list(workspaceId, { search: dSearch || undefined }) });
  const members: WorkspaceMember[] = (data as { members?: WorkspaceMember[] })?.members ?? [];
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-text-primary">Members</h1>
        {isAdmin && <Button size="sm" onClick={() => setShowInvite(true)}><UserPlus size={14} />Invite</Button>}
      </div>
      <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input className="w-full pl-9 pr-4 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary bg-white" placeholder="Search members..." value={search} onChange={e => setSearch(e.target.value)} /></div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && members.length === 0 && <EmptyState icon={<Users size={36} />} title="No members found" action={isAdmin && <Button size="sm" onClick={() => setShowInvite(true)}><UserPlus size={14} />Invite</Button>} />}
      <div className="space-y-2">
        {members.map(m => (
          <div key={m.id} onClick={() => nav(`/app/members/${m.id}`)} className="bg-white border border-border rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:border-primary transition-colors">
            <Avatar src={m.avatar_url} name={m.display_name} size="md" />
            <div className="flex-1 min-w-0"><p className="font-medium text-text-primary text-sm truncate">{m.display_name}</p>{m.email && <p className="text-xs text-text-secondary truncate">{m.email}</p>}</div>
            <div className="flex items-center gap-2 flex-shrink-0"><Badge status={m.role} label={m.role} />{m.is_proxy && <Badge status="archived" label="Proxy" />}</div>
          </div>
        ))}
      </div>
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
    </div>
  );
}
