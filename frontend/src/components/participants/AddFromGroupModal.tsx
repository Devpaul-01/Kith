// components/participants/AddFromGroupModal.tsx
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { groupService, type Group } from '@/services/group.service';
import { participantService } from '@/services/participant.service';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import showToast from '@/lib/toast';

interface AddFromGroupModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  containerId: string;
  enableMoney: boolean;
  enableTasks: boolean;
  onSuccess: () => void;
}

export function AddFromGroupModal({
  open,
  onClose,
  workspaceId,
  containerId,
  enableMoney,
  enableTasks,
  onSuccess,
}: AddFromGroupModalProps) {
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [moneyEnabled, setMoneyEnabled] = useState(enableMoney);
  const [tasksEnabled, setTasksEnabled] = useState(enableTasks);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch groups
  const { data: groupsData, isLoading: groupsLoading } = useQuery({
    queryKey: ['groups', workspaceId],
    queryFn: () => groupService.list(workspaceId),
    enabled: open,
  });

  const groups: Group[] = groupsData?.groups ?? [];

  // Reset form when modal opens/closes
  useEffect(() => {
    if (open) {
      setSelectedGroupId('');
      setMoneyEnabled(enableMoney);
      setTasksEnabled(enableTasks);
    }
  }, [open, enableMoney, enableTasks]);

  const handleSubmit = async () => {
    if (!selectedGroupId) {
      showToast.error('Please select a group');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await participantService.addFromGroup(workspaceId, containerId, {
        group_id: selectedGroupId,
        money_enabled: moneyEnabled,
        tasks_enabled: tasksEnabled,
      });
      
      const addedCount = result.added || 0;
      const skippedCount = result.skipped || 0;
      
      if (addedCount > 0) {
        showToast.success(`Added ${addedCount} participant${addedCount !== 1 ? 's' : ''} from group${skippedCount > 0 ? ` (${skippedCount} already in container)` : ''}`);
      } else if (skippedCount > 0) {
        showToast.info(`All ${skippedCount} members were already participants`);
      } else {
        showToast.info('No new participants added');
      }
      
      onSuccess();
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.error?.message || 'Failed to add participants from group';
      showToast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedGroup = groups.find(g => g.id === selectedGroupId);

  return (
    <Modal open={open} onClose={onClose} title="Add Participants from Group">
      <div className="space-y-4">
        {/* Group selection */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">
            Select Group
          </label>
          {groupsLoading ? (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-text-secondary italic">
              No groups available. Create a group first in the Members section.
            </p>
          ) : (
            <select
              className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
              value={selectedGroupId}
              onChange={(e) => setSelectedGroupId(e.target.value)}
            >
              <option value="">-- Select a group --</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} ({group.member_count} member{group.member_count !== 1 ? 's' : ''})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Group info preview */}
        {selectedGroup && (
          <div className="bg-surface-alt rounded-lg p-3 text-sm">
            <p className="font-medium text-text-primary">{selectedGroup.name}</p>
            {selectedGroup.description && (
              <p className="text-text-secondary text-xs mt-1">{selectedGroup.description}</p>
            )}
            <p className="text-text-secondary text-xs mt-2">
              {selectedGroup.member_count} member{selectedGroup.member_count !== 1 ? 's' : ''} will be added
            </p>
          </div>
        )}

        {/* Feature toggles */}
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Feature Settings
          </p>
          
          {enableMoney && (
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-primary"
                checked={moneyEnabled}
                onChange={(e) => setMoneyEnabled(e.target.checked)}
              />
              <span className="text-sm text-text-primary">Enable money tracking for added members</span>
            </label>
          )}
          
          {enableTasks && (
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-primary"
                checked={tasksEnabled}
                onChange={(e) => setTasksEnabled(e.target.checked)}
              />
              <span className="text-sm text-text-primary">Enable tasks for added members</span>
            </label>
          )}
        </div>

        {/* Warning if no money/tasks enabled but container has them */}
        {enableMoney && !moneyEnabled && (
          <p className="text-xs text-warning bg-warning/10 rounded-lg p-2">
            ⚠️ Money tracking is enabled for this container, but you're not enabling it for these participants. They won't be able to record contributions.
          </p>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            fullWidth
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={!selectedGroupId || groupsLoading}
          >
            Add from Group
          </Button>
        </div>
      </div>
    </Modal>
  );
}