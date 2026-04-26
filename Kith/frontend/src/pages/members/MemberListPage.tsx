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
import { Select } from '@/components/ui/Select';
import { useNavigate } from 'react-router-dom';
import { Search, Users, UserPlus, Filter, BarChart3 } from 'lucide-react';
import { InviteModal } from './InviteModal';
import { CreateMemberModal } from '@/components/members/CreateMemberModal';
import type { WorkspaceMember } from '@/types/models';

const ROLE_FILTERS = [
  { value: '', label: 'All Roles' },
  { value: 'admin', label: 'Admins' },
  { value: 'member', label: 'Members' },
];

const PROXY_FILTERS = [
  { value: '', label: 'All Members' },
  { value: 'false', label: 'Regular Members' },
  { value: 'true', label: 'Proxy Members' },
];

export default function MemberListPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [proxyFilter, setProxyFilter] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [showCreateMember, setShowCreateMember] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const dSearch = useDebounce(search, 300);

  // Fetch admins for proxy management dropdown in create modal
  const { data: allMembersData } = useQuery({
    queryKey: [...KEYS.members(workspaceId), { all: true }],
    queryFn: () => memberService.list(workspaceId, {}),
    enabled: isAdmin && showCreateMember,
  });
  const admins = (allMembersData as { members?: WorkspaceMember[] })?.members?.filter(m => m.role === 'admin') ?? [];

  const { data, isLoading } = useQuery({
    queryKey: [...KEYS.members(workspaceId), { search: dSearch, role: roleFilter, proxy: proxyFilter }],
    queryFn: () => memberService.list(workspaceId, {
      search: dSearch || undefined,
      'filter[role]': roleFilter || undefined,
      'filter[is_proxy]': proxyFilter || undefined,
    }),
  });

  const members: WorkspaceMember[] = (data as { members?: WorkspaceMember[] })?.members ?? [];
  const meta = (data as { meta?: { total: number; admins_count: number; proxy_count: number; active_count: number } })?.meta;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Members</h1>
          {meta && (
            <p className="text-xs text-text-secondary mt-0.5">
              {meta.total} total · {meta.admins_count} admins · {meta.proxy_count} proxies · {meta.active_count} active
            </p>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => nav('/app/members/engagement')}>
              <BarChart3 size={14} /> Engagement
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowCreateMember(true)}>
              <UserPlus size={14} /> Add Member
            </Button>
            <Button size="sm" onClick={() => setShowInvite(true)}>
              <UserPlus size={14} /> Invite
            </Button>
          </div>
        )}
      </div>

      {/* Search and Filters */}
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              className="w-full pl-9 pr-4 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary bg-white"
              placeholder="Search members..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {isAdmin && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1"
            >
              <Filter size={14} /> Filters
            </Button>
          )}
        </div>

        {/* Expandable Filters */}
        {showFilters && isAdmin && (
          <div className="flex gap-3">
            <Select
              options={ROLE_FILTERS}
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="flex-1"
            />
            <Select
              options={PROXY_FILTERS}
              value={proxyFilter}
              onChange={(e) => setProxyFilter(e.target.value)}
              className="flex-1"
            />
            {(roleFilter || proxyFilter) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRoleFilter('');
                  setProxyFilter('');
                }}
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Member List */}
      {isLoading && (
        <div className="flex justify-center py-8"><Spinner /></div>
      )}

      {!isLoading && members.length === 0 && (
        <EmptyState
          icon={<Users size={36} />}
          title="No members found"
          description={search || roleFilter || proxyFilter ? "Try adjusting your filters" : "Invite your first member to get started"}
          action={isAdmin && !search && !roleFilter && !proxyFilter && (
            <Button size="sm" onClick={() => setShowInvite(true)}>
              <UserPlus size={14} /> Invite Member
            </Button>
          )}
        />
      )}

      <div className="space-y-2">
        {members.map(m => (
          <div
            key={m.id}
            onClick={() => nav(`/app/members/${m.id}`)}
            className="bg-white border border-border rounded-xl p-4 flex items-center gap-3 cursor-pointer hover:border-primary transition-colors"
          >
            <Avatar src={m.avatar_url} name={m.display_name} size="md" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary text-sm truncate">{m.display_name}</p>
              {m.email && <p className="text-xs text-text-secondary truncate">{m.email}</p>}
              {(m as any).relationship_to_head && (
                <p className="text-xs text-text-secondary mt-0.5">{(m as any).relationship_to_head}</p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {m.engagement_level && (
                <Badge status={m.engagement_level === 'active' ? 'success' : m.engagement_level === 'quiet' ? 'warning' : 'archived'} />
              )}
              <Badge status={m.role} label={m.role} />
              {m.is_proxy && <Badge status="archived" label="Proxy" />}
            </div>
          </div>
        ))}
      </div>

      {/* Modals */}
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} />}
      {showCreateMember && (
        <CreateMemberModal
          open={showCreateMember}
          onClose={() => setShowCreateMember(false)}
          workspaceId={workspaceId}
          admins={admins}
        />
      )}
    </div>
  );
}