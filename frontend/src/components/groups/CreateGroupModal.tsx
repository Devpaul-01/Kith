// components/groups/CreateGroupModal.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { groupService } from '@/services/group.service';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import showToast from '@/lib/toast';
import type { WorkspaceMember } from '@/types/models';

const createGroupSchema = z.object({
  name: z.string().min(1, 'Group name is required'),
  description: z.string().optional(),
});

type CreateGroupForm = z.infer<typeof createGroupSchema>;

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

export function CreateGroupModal({ open, onClose, workspaceId }: CreateGroupModalProps) {
  const qc = useQueryClient();
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateGroupForm>({
    resolver: zodResolver(createGroupSchema),
  });

  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: KEYS.members(workspaceId),
    queryFn: () => memberService.list(workspaceId),
    enabled: open,
  });

  const members: WorkspaceMember[] = (membersData as { members?: WorkspaceMember[] })?.members ?? [];

  const createMutation = useMutation({
    mutationFn: (data: CreateGroupForm) =>
      groupService.create(workspaceId, {
        name: data.name,
        description: data.description,
        member_ids: selectedMemberIds,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.groups(workspaceId) });
      showToast.success('Group created successfully');
      reset();
      setSelectedMemberIds([]);
      onClose();
    },
    onError: () => showToast.error('Failed to create group'),
  });

  const toggleMember = (memberId: string) => {
    setSelectedMemberIds(prev =>
      prev.includes(memberId) ? prev.filter(id => id !== memberId) : [...prev, memberId]
    );
  };

  const onSubmit = (data: CreateGroupForm) => {
    createMutation.mutate(data);
  };

  const handleClose = () => {
    reset();
    setSelectedMemberIds([]);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Create Group" size="lg">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Input
          label="Group Name *"
          placeholder="e.g., Core Family, Event Planners"
          error={errors.name?.message}
          {...register('name')}
        />
        <Textarea
          label="Description (optional)"
          placeholder="What is this group for?"
          rows={2}
          {...register('description')}
        />

        {/* Member Selection */}
        <div>
          <label className="text-xs font-medium text-text-secondary mb-2 block">
            Add Members (optional)
          </label>
          {membersLoading ? (
            <div className="text-center py-4 text-text-secondary">Loading members...</div>
          ) : members.length === 0 ? (
            <div className="text-center py-4 text-text-secondary border border-dashed border-border rounded-lg">
              No members available. Add members first.
            </div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto border border-border rounded-lg p-2">
              {members.map((member) => (
                <label
                  key={member.id}
                  className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-surface transition-colors"
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
                    <div className="flex items-center gap-2">
                      <Badge status={member.role} label={member.role} />
                      {member.is_proxy && <Badge status="archived" label="Proxy" />}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
          {selectedMemberIds.length > 0 && (
            <p className="text-xs text-text-secondary mt-2">
              {selectedMemberIds.length} member{selectedMemberIds.length !== 1 ? 's' : ''} selected
            </p>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button fullWidth type="submit" loading={createMutation.isPending}>
            Create Group
          </Button>
        </div>
      </form>
    </Modal>
  );
}