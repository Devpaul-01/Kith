// components/tasks/BulkCreateTasksModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { taskService } from '@/services/task.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import showToast from '@/lib/toast';

interface BulkCreateTasksModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  containerId: string;
  participants: Array<{ workspace_member_id: string; display_name: string }>;
}

export function BulkCreateTasksModal({
  open,
  onClose,
  workspaceId,
  containerId,
  participants,
}: BulkCreateTasksModalProps) {
  const qc = useQueryClient();
  const [bulkText, setBulkText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const bulkCreateMutation = useMutation({
    mutationFn: async () => {
      // Parse the bulk text
      const lines = bulkText.split('\n').filter(line => line.trim());
      const tasks = [];
      const parseErrors: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Format: "Title | Description | Due Date | Assigned To Name"
        // All fields except Title are optional
        const parts = line.split('|').map(p => p.trim());
        const title = parts[0];
        
        if (!title) {
          parseErrors.push(`Line ${i + 1}: Title is required`);
          continue;
        }

        const description = parts[1] || undefined;
        const dueDate = parts[2] || undefined;
        const assignedToName = parts[3] || undefined;

        // Find assigned_to by name if provided
        let assignedToId: string | undefined;
        if (assignedToName) {
          const matched = participants.find(
            p => p.display_name.toLowerCase() === assignedToName.toLowerCase() ||
                 p.display_name.toLowerCase().includes(assignedToName.toLowerCase())
          );
          if (matched) {
            assignedToId = matched.workspace_member_id;
          } else {
            parseErrors.push(`Line ${i + 1}: Could not find participant "${assignedToName}"`);
            continue;
          }
        }

        tasks.push({
          title,
          description,
          due_date: dueDate || undefined,
          assigned_to: assignedToId,
        });
      }

      if (parseErrors.length > 0) {
        setErrors(parseErrors);
        throw new Error('Parse errors');
      }

      if (tasks.length === 0) {
        throw new Error('No valid tasks to create');
      }

      return taskService.bulkCreate(workspaceId, containerId, { tasks });
    },
    onSuccess: (result) => {
      const createdCount = result?.created?.length || 0;
      const failedCount = result?.failed?.length || 0;
      
      if (createdCount > 0) {
        showToast.success(`${createdCount} task${createdCount !== 1 ? 's' : ''} created${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);
      } else if (failedCount > 0) {
        showToast.error(`Failed to create ${failedCount} tasks`);
      }
      
      qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId, containerId) });
      setBulkText('');
      setErrors([]);
      onClose();
    },
    onError: (error: any) => {
      if (error.message !== 'Parse errors') {
        const message = error?.response?.data?.error?.message || 'Failed to create tasks';
        showToast.error(message);
      }
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const handleSubmit = () => {
    if (!bulkText.trim()) {
      showToast.error('Please enter at least one task');
      return;
    }
    setErrors([]);
    setIsSubmitting(true);
    bulkCreateMutation.mutate();
  };

  const handleClose = () => {
    setBulkText('');
    setErrors([]);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Create Tasks" size="lg">
      <div className="space-y-4">
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
          <p className="text-xs text-blue-700 font-medium mb-1">Format Instructions:</p>
          <p className="text-xs text-blue-600">
            Enter one task per line. Use pipe (|) to separate fields:
          </p>
          <code className="text-xs text-blue-800 block mt-1 bg-blue-100 p-2 rounded">
            Task Title | Description | YYYY-MM-DD | Assigned Person Name
          </code>
          <p className="text-xs text-blue-600 mt-1">
            Only Title is required. Description, Due Date, and Assigned Person are optional.
          </p>
        </div>

        <Textarea
          label="Tasks"
          placeholder="Example:
Birthday cake order | Order chocolate cake | 2024-12-25 | John Doe
Buy decorations | Purchase balloons and streamers | 2024-12-24
Send invitations | Email invites to all guests"
          rows={10}
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
        />

        {/* Participant list reference */}
        {participants.length > 0 && (
          <div className="rounded-lg bg-surface-alt p-3">
            <p className="text-xs font-medium text-text-secondary mb-1">Available Participants:</p>
            <div className="flex flex-wrap gap-1">
              {participants.map(p => (
                <span key={p.workspace_member_id} className="text-xs bg-white px-2 py-0.5 rounded-full border border-border">
                  {p.display_name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Parse errors */}
        {errors.length > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3">
            <p className="text-xs text-red-700 font-medium mb-1">Errors:</p>
            <ul className="text-xs text-red-600 list-disc list-inside">
              {errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            fullWidth
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={!bulkText.trim()}
          >
            Create Tasks
          </Button>
        </div>
      </div>
    </Modal>
  );
}