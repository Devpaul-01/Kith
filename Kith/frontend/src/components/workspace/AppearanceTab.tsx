// components/workspace/AppearanceTab.tsx
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspaceService, type Workspace } from '@/services/workspace.service';
import { useFileUpload } from '@/hooks/useFileUpload';
import { KEYS } from '@/constants/queryKeys';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import showToast from '@/lib/toast';
import { Upload } from 'lucide-react';

interface AppearanceTabProps {
  workspace: Workspace;
  onUpdate: (payload: { avatar_url?: string | null }) => void;
  isUpdating: boolean;
}

export function AppearanceTab({ workspace, onUpdate, isUpdating }: AppearanceTabProps) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploadFile, uploading } = useFileUpload();
  const [isUploading, setIsUploading] = useState(false);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast.error('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast.error('Image must be less than 5MB');
      return;
    }

    setIsUploading(true);
    try {
      const result = await uploadFile(
        (f) => workspaceService.getAvatarUploadUrl(workspace.id, f),
        (filePath) => onUpdate({ avatar_url: filePath }),
        file
      );
      if (result) {
        qc.invalidateQueries({ queryKey: KEYS.workspace(workspace.id) });
        showToast.success('Workspace avatar updated');
      }
    } catch (error) {
      showToast.error('Failed to upload avatar');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium text-text-secondary mb-2 block">
            Workspace Avatar
          </label>
          <div className="flex items-center gap-4">
            <Avatar
              src={workspace.avatar_url}
              name={workspace.name}
              size="lg"
              className="border-2 border-border"
            />
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => fileRef.current?.click()}
                loading={uploading || isUploading}
              >
                <Upload size={14} className="mr-1" /> Change Avatar
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />
              <p className="text-xs text-text-secondary mt-2">
                Recommended: Square image, at least 200x200px. Max 5MB.
              </p>
            </div>
          </div>
        </div>

        {workspace.avatar_url && (
          <div className="border-t border-border pt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onUpdate({ avatar_url: null })}
              disabled={isUpdating}
            >
              Remove Avatar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}