// components/groups/GroupDetailModal.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { groupService, type Group, type GroupMember } from '@/services/group.service';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import showToast from '@/lib/toast';
import { Users, UserPlus, Trash2, Pencil, X } from 'lucide-react';
import type { WorkspaceMember } from '@/types/models';

interface GroupDetailModalProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
  workspaceId: string;
}

export function GroupDetailModal({ open, onClose, groupId, workspaceId }: GroupDetailModalProps) {
  const qc = useQueryClient();
  const [showEditModal, setShowEditModal] = useState(false);
  const [showAddMembersModal, setShowAddMembersModal] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '' });

  // Fetch group details
  const { data, isLoading } = useQuery({
    queryKey: KEYS.group(workspaceId, groupId),
    queryFn: () => groupService.get(workspaceId, groupId),
    enabled: open,
  });

  // Fetch available members for adding
  const { data: membersData } = useQuery({
    queryKey: KEYS.members(workspaceId),
    queryFn: () => memberService.list(workspaceId),
    enabled: open && showAddMembersModal,
  });

  const group = data?.group;
  const members: GroupMember[] = data?.members ?? [];
  const availableMembers: WorkspaceMember[] = (membersData as { members?: WorkspaceMember[] })?.members ?? [];
  
  // Filter out members already in the group
  const memberIdsInGroup = new Set(members.map(m => m.id));
  const membersNotInGroup = availableMembers.filter(m => !memberIdsInGroup.has(m.id));

  // Update group mutation
  const updateMutation = useMutation({
    mutationFn: () => groupService.update(workspaceId, groupId, editForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.group(workspaceId, groupId) });
      qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) });
      showToast.success('Group updated');
      setShowEditModal(false);
    },
    onError: () => showToast.error('Failed to update group'),
  });

  // Add members mutation
  const addMembersMutation = useMutation({
    mutationFn: (memberIds: string[]) => groupService.addMembers(workspaceId, groupId, memberIds),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: KEYS.group(workspaceId, groupId) });
      qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) });
      showToast.success(`Added ${result.added_count} member${result.added_count !== 1 ? 's' : ''}`);
      setShowAddMembersModal(false);
    },
    onError: () => showToast.error('Failed to add members'),
  });

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => groupService.removeMember(workspaceId, groupId, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.group(workspaceId, groupId) });
      qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) });
      showToast.success('Member removed from group');
    },
    onError: () => showToast.error('Failed to remove member'),
  });

  const handleAddMembers = (selectedMemberIds: string[]) => {
    if (selectedMemberIds.length === 0) {
      showToast.error('Please select at least one member');
      return;
    }
    addMembersMutation.mutate(selectedMemberIds);
  };

  if (isLoading) {
    return (
      <Modal open={open} onClose={onClose} title="Group Details">
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </Modal>
    );
  }

  if (!group) {
    return (
      <Modal open={open} onClose={onClose} title="Group Details">
        <div className="text-center py-8 text-text-secondary">Group not found.</div>
      </Modal>
    );
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={group.name} size="lg">
        <div className="space-y-4">
          {/* Group Info */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={18} className="text-text-secondary" />
              <span className="text-sm text-text-secondary">{members.length} members</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setEditForm({ name: group.name, description: group.description || '' });
                  setShowEditModal(true);
                }}
                className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
                title="Edit group"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => setShowAddMembersModal(true)}
                className="p-1.5 rounded-lg text-text-secondary hover:text-primary hover:bg-surface-secondary transition-colors"
                title="Add members"
              >
                <UserPlus size={14} />
              </button>
            </div>
          </div>

          {group.description && (
            <p className="text-sm text-text-secondary">{group.description}</p>
          )}

          {/* Members List */}
          {members.length === 0 ? (
            <div className="text-center py-6 text-text-secondary border border-dashed border-border rounded-lg">
              <Users size={32} className="mx-auto mb-2 opacity-50" />
              <p className="text-sm">No members yet</p>
              <button
                onClick={() => setShowAddMembersModal(true)}
                className="text-xs text-primary hover:underline mt-1"
              >
                Add members
              </button>
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-3 bg-surface-alt rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <Avatar name={member.display_name} size="sm" />
                    <div>
                      <p className="font-medium text-text-primary text-sm">{member.display_name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge status={member.role} label={member.role} />
                        {member.is_proxy && <Badge status="archived" label="Proxy" />}
                        {member.relationship_to_head && (
                          <span className="text-xs text-text-secondary">
                            {member.relationship_to_head}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (confirm(`Remove ${member.display_name} from this group?`)) {
                        removeMemberMutation.mutate(member.id);
                      }
                    }}
                    disabled={removeMemberMutation.isPending}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-red-50 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Edit Group Modal */}
      <Modal open={showEditModal} onClose={() => setShowEditModal(false)} title="Edit Group">
        <div className="space-y-4">
          <Input
            label="Group Name"
            value={editForm.name}
            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
          />
          <Textarea
            label="Description"
            rows={2}
            value={editForm.description}
            onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
          />
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={() => setShowEditModal(false)}>
              Cancel
            </Button>
            <Button fullWidth onClick={() => updateMutation.mutate()} loading={updateMutation.isPending}>
              Save Changes
            </Button>
          </div>
        </div>
      </Modal>

      {/* Add Members Modal */}
      <AddMembersModal
        open={showAddMembersModal}
        onClose={() => setShowAddMembersModal(false)}
        availableMembers={membersNotInGroup}
        onAdd={handleAddMembers}
        isLoading={addMembersMutation.isPending}
      />
    </>
  );
}

// Add Members Modal Component
interface AddMembersModalProps {
  open: boolean;
  onClose: () => void;
  availableMembers: WorkspaceMember[];
  onAdd: (memberIds: string[]) => void;
  isLoading: boolean;
}

function AddMembersModal({ open, onClose, availableMembers, onAdd, isLoading }: AddMembersModalProps) {
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  const toggleMember = (memberId: string) => {
    setSelectedMemberIds(prev =>
      prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId]
    );
  };

  const handleAdd = () => {
    onAdd(selectedMemberIds);
    setSelectedMemberIds([]);
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Members to Group">
      <div className="space-y-4">
        {availableMembers.length === 0 ? (
          <div className="text-center py-6 text-text-secondary">
            No members available to add.
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {availableMembers.map((member) => (
              <label
                key={member.id}
                className="flex items-center gap-3 p-3 bg-surface-alt rounded-lg cursor-pointer hover:bg-surface transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedMemberIds.includes(member.id)}
                  onChange={() => toggleMember(member.id)}
                  className="w-4 h-4 accent-primary"
                />
                <Avatar name={member.display_name} size="sm" />
                <div className="flex-1">
                  <p className="font-medium text-text-primary text-sm">{member.display_name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge status={member.role} label={member.role} />
                    {member.is_proxy && <Badge status="archived" label="Proxy" />}
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth onClick={onClose}>
            Cancel
          </Button>
          <Button
            fullWidth
            onClick={handleAdd}
            loading={isLoading}
            disabled={selectedMemberIds.length === 0}
          >
            Add {selectedMemberIds.length} Member{selectedMemberIds.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}