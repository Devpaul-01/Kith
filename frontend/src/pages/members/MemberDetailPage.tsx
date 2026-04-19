import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useMember } from '@/hooks/useMember';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { Button } from '@/components/ui/Button';
import { EditMemberModal } from '@/components/members/EditMemberModal';
import { ProfileHistoryTab } from '@/components/members/ProfileHistoryTab';
import { ContributionSummaryTab } from '@/components/members/ContributionSummaryTab';
import { Pencil, Trash2, AlertTriangle } from 'lucide-react';
import showToast from '@/lib/toast';
import type { WorkspaceMember } from '@/types/models';

type TabId = 'overview' | 'contributions' | 'history';

export default function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const currentMember = useMember();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: KEYS.member(workspaceId, id!),
    queryFn: () => memberService.get(workspaceId, id!),
    enabled: !!id,
  });

  const { data: allMembersData } = useQuery({
    queryKey: KEYS.members(workspaceId),
    queryFn: () => memberService.list(workspaceId, {}),
    enabled: isAdmin && showEditModal,
  });

  const member: WorkspaceMember | undefined = (data as { member?: WorkspaceMember })?.member;
  const admins = (allMembersData as { members?: WorkspaceMember[] })?.members?.filter(m => m.role === 'admin') ?? [];
  const isSelf = currentMember?.id === id;
  const isLastAdmin = member?.role === 'admin' && admins.length === 1;

  const deleteMutation = useMutation({
    mutationFn: (force?: boolean) => memberService.delete(workspaceId, id!, force),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.members(workspaceId) });
      showToast.success('Member removed');
      navigate('/app/members');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to remove member';
      if (message.includes('confirmed ledger entries')) {
        showToast.error('Member has confirmed contributions. Use force delete?', { duration: 5000 });
        // Could show a confirmation dialog with force option
      } else {
        showToast.error(message);
      }
    },
  });

  const handleDelete = () => {
    if (isLastAdmin) {
      showToast.error('Cannot remove the last admin. Promote another member first.');
      return;
    }
    deleteMutation.mutate();
  };

  const handleForceDelete = () => {
    if (confirm('⚠️ This member has confirmed contributions. Deleting will permanently remove all data. This cannot be undone. Continue?')) {
      deleteMutation.mutate(true);
    }
    setShowDeleteConfirm(false);
  };

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'contributions', label: 'Contributions' },
    ...(isAdmin ? [{ id: 'history', label: 'Profile History' }] : []),
  ];

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!member) return <div className="p-6 text-center text-text-secondary">Member not found.</div>;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      {/* Header Card */}
      <Card className="relative">
        <div className="flex items-start gap-4">
          <Avatar src={member.avatar_url} name={member.display_name} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h1 className="text-xl font-bold text-text-primary">{member.display_name}</h1>
              <div className="flex items-center gap-2">
                {isAdmin && !isSelf && (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-surface-secondary transition-colors"
                    title="Remove member"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
                {(isAdmin || isSelf) && (
                  <button
                    onClick={() => setShowEditModal(true)}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
                    title="Edit member"
                  >
                    <Pencil size={15} />
                  </button>
                )}
              </div>
            </div>
            {member.email && <p className="text-sm text-text-secondary">{member.email}</p>}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge status={member.role} label={member.role} />
              {member.is_proxy && <Badge status="archived" label="Proxy" />}
              {!member.is_active && <Badge status="archived" label="Inactive" />}
              {(member as any).relationship_to_head && (
                <span className="text-xs bg-surface-alt px-2 py-0.5 rounded-full text-text-secondary">
                  {(member as any).relationship_to_head}
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <Card>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-secondary text-xs">Status</p>
              <p className="font-medium text-text-primary">
                {member.is_active ? 'Active' : 'Inactive'}
              </p>
            </div>
            <div>
              <p className="text-text-secondary text-xs">Role</p>
              <p className="font-medium text-text-primary capitalize">{member.role}</p>
            </div>
            {member.is_proxy && (member as any).proxy_managed_by && (
              <div>
                <p className="text-text-secondary text-xs">Managed By</p>
                <p className="font-medium text-text-primary">
                  {admins.find(a => a.id === (member as any).proxy_managed_by)?.display_name || 'Unknown'}
                </p>
              </div>
            )}
            {(member as any).relationship_category && (
              <div>
                <p className="text-text-secondary text-xs">Relationship Category</p>
                <p className="font-medium text-text-primary capitalize">
                  {(member as any).relationship_category}
                </p>
              </div>
            )}
            {(member as any).date_of_birth && (
              <div>
                <p className="text-text-secondary text-xs">Date of Birth</p>
                <p className="font-medium text-text-primary">
                  {new Date((member as any).date_of_birth).toLocaleDateString()}
                </p>
              </div>
            )}
            <div>
              <p className="text-text-secondary text-xs">Joined</p>
              <p className="font-medium text-text-primary">
                {new Date(member.created_at).toLocaleDateString()}
              </p>
            </div>
            {(member as any).admin_notes && isAdmin && (
              <div className="col-span-2">
                <p className="text-text-secondary text-xs">Admin Notes</p>
                <p className="text-sm text-text-secondary bg-surface-alt p-2 rounded-lg mt-1">
                  {(member as any).admin_notes}
                </p>
              </div>
            )}
          </div>
        </Card>
      )}

      {activeTab === 'contributions' && (
        <ContributionSummaryTab workspaceId={workspaceId} memberId={member.id} />
      )}

      {activeTab === 'history' && isAdmin && (
        <ProfileHistoryTab workspaceId={workspaceId} memberId={member.id} />
      )}

      {/* Edit Modal */}
      <EditMemberModal
        open={showEditModal}
        onClose={() => setShowEditModal(false)}
        member={member}
        workspaceId={workspaceId}
        isSelf={isSelf}
        admins={admins}
        onSuccess={() => {
          qc.invalidateQueries({ queryKey: KEYS.member(workspaceId, member.id) });
        }}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center gap-3 text-danger">
              <AlertTriangle size={24} />
              <h3 className="text-lg font-semibold">Remove Member</h3>
            </div>
            <p className="text-text-secondary">
              Are you sure you want to remove <strong>{member.display_name}</strong> from this workspace?
            </p>
            {isLastAdmin && (
              <p className="text-sm text-danger bg-danger/10 p-2 rounded-lg">
                ⚠️ This is the last admin. You cannot remove them. Promote another member first.
              </p>
            )}
            <div className="flex gap-3 pt-2">
              <Button variant="secondary" fullWidth onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                fullWidth
                onClick={handleDelete}
                disabled={isLastAdmin}
                loading={deleteMutation.isPending}
              >
                Remove Member
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}