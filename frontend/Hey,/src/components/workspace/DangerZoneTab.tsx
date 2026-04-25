// components/workspace/DangerZoneTab.tsx
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import showToast from '@/lib/toast';
import { AlertTriangle, Trash2 } from 'lucide-react';

interface DangerZoneTabProps {
  workspaceId: string;
  workspaceName: string;
  onDelete: () => void;
  isDeleting: boolean;
}

export function DangerZoneTab({ workspaceName, onDelete, isDeleting }: DangerZoneTabProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const handleDelete = () => {
    if (confirmName !== workspaceName) {
      showToast.error('Workspace name does not match');
      return;
    }
    if (confirmText !== 'delete') {
      showToast.error('Please type "delete" to confirm');
      return;
    }
    onDelete();
    setShowDeleteModal(false);
  };

  return (
    <>
      <Card className="border-danger/30 bg-danger/5">
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-danger">
            <AlertTriangle size={20} />
            <h3 className="font-semibold">Delete Workspace</h3>
          </div>
          <p className="text-sm text-text-secondary">
            Once you delete a workspace, there is no going back. Please be certain.
          </p>
          <ul className="text-sm text-text-secondary list-disc list-inside space-y-1">
            <li>All containers, tasks, and ledger entries will be deleted</li>
            <li>All members will lose access to this workspace</li>
            <li>This action cannot be undone</li>
          </ul>
          <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
            <Trash2 size={14} className="mr-1" /> Delete Workspace
          </Button>
        </div>
      </Card>

      <Modal open={showDeleteModal} onClose={() => setShowDeleteModal(false)} title="Delete Workspace">
        <div className="space-y-4">
          <div className="rounded-lg bg-danger/10 border border-danger/30 p-3">
            <p className="text-sm text-danger font-medium">Warning: This action cannot be undone!</p>
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1">
              Type the workspace name to confirm: <span className="font-mono bg-surface-alt px-1 rounded">{workspaceName}</span>
            </label>
            <Input
              placeholder={workspaceName}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary block mb-1">
              Type <span className="font-mono bg-surface-alt px-1 rounded">delete</span> to confirm
            </label>
            <Input
              placeholder="delete"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth onClick={() => setShowDeleteModal(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              fullWidth
              onClick={handleDelete}
              loading={isDeleting}
              disabled={confirmName !== workspaceName || confirmText !== 'delete'}
            >
              Permanently Delete
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}