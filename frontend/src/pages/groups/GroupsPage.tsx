import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { groupService, type Group } from '@/services/group.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';
import { GroupDetailModal } from '@/components/groups/GroupDetailModal';
import { CreateGroupModal } from '@/components/groups/CreateGroupModal';
import { Plus, Users2, Trash2, Edit } from 'lucide-react';
import showToast from '@/lib/toast';

export default function GroupsPage() {
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: KEYS.groups(workspaceId),
    queryFn: () => groupService.list(workspaceId),
  });

  const groups: Group[] = (data as { groups?: Group[] })?.groups ?? [];

  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => groupService.delete(workspaceId, groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) });
      showToast.success('Group deleted');
    },
    onError: () => showToast.error('Failed to delete group'),
  });

  const handleDelete = (groupId: string, groupName: string) => {
    if (confirm(`Delete group "${groupName}"? This action cannot be undone.`)) {
      deleteMutation.mutate(groupId);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Groups</h1>
          <p className="text-xs text-text-secondary mt-0.5">
            {groups.length} group{groups.length !== 1 ? 's' : ''} total
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> Create Group
          </Button>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && groups.length === 0 && (
        <EmptyState
          icon={<Users2 size={36} />}
          title="No groups yet"
          description="Create groups to organize members for easy adding to containers."
          action={
            isAdmin ? (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={14} /> Create Group
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Groups Grid */}
      {!isLoading && groups.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-4">
          {groups.map((group) => (
            <Card
              key={group.id}
              className="cursor-pointer hover:border-primary transition-all"
              onClick={() => setSelectedGroupId(group.id)}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <Users2 className="text-primary" size={18} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">{group.name}</h3>
                    {group.description && (
                      <p className="text-xs text-text-secondary line-clamp-1">{group.description}</p>
                    )}
                    <p className="text-xs text-text-secondary mt-1">
                      {group.member_count ?? 0} member{group.member_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(group.id, group.name);
                    }}
                    disabled={deleteMutation.isPending}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-red-50 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {/* Member Avatars Preview */}
              {group.members && group.members.length > 0 && (
                <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border">
                  {group.members.slice(0, 4).map((member) => (
                    <Avatar
                      key={member.id}
                      name={member.display_name}
                      size="xs"
                      className="border-2 border-white"
                    />
                  ))}
                  {group.members.length > 4 && (
                    <div className="w-6 h-6 rounded-full bg-surface-alt flex items-center justify-center text-xs text-text-secondary">
                      +{group.members.length - 4}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Modals */}
      <CreateGroupModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        workspaceId={workspaceId}
      />

      {selectedGroupId && (
        <GroupDetailModal
          open={!!selectedGroupId}
          onClose={() => setSelectedGroupId(null)}
          groupId={selectedGroupId}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
}