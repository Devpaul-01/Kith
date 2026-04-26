// components/milestones/MilestoneCard.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { milestoneService } from '@/services/milestone.service';
import { KEYS } from '@/constants/queryKeys';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import showToast from '@/lib/toast';
import { formatDate } from '@/utils/date';
import { Pencil, Trash2, Image as ImageIcon, X, Upload } from 'lucide-react';
import type { Milestone } from '@/types/models';

const MILESTONE_TYPES = [
  { value: 'birth', label: '🎂 Birth' },
  { value: 'graduation', label: '🎓 Graduation' },
  { value: 'wedding', label: '💍 Wedding' },
  { value: 'death', label: '🕊️ Memorial' },
  { value: 'migration', label: '✈️ Migration' },
  { value: 'achievement', label: '🏆 Achievement' },
  { value: 'custom', label: '📌 Custom' },
];

interface MilestoneCardProps {
  milestone: Milestone;
  workspaceId: string;
  isAdmin: boolean;
  onDelete?: () => void;
  onUpdate?: () => void;
}

export function MilestoneCard({ milestone, workspaceId, isAdmin, onDelete, onUpdate }: MilestoneCardProps) {
  const qc = useQueryClient();
  const [showEditModal, setShowEditModal] = useState(false);
  const [showPhotoModal, setShowPhotoModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [editForm, setEditForm] = useState({
    title: milestone.title,
    milestone_date: milestone.milestone_date,
    description: milestone.description || '',
    milestone_type: milestone.milestone_type || 'custom',
  });

  const updateMutation = useMutation({
    mutationFn: () => milestoneService.update(workspaceId, milestone.id, editForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) });
      showToast.success('Milestone updated');
      setShowEditModal(false);
      onUpdate?.();
    },
    onError: () => showToast.error('Failed to update milestone'),
  });

  const uploadPhotoMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('No file selected');

      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const BUCKET = 'kith-files';

      const { upload_url, file_path } = await milestoneService.getPhotoUploadUrl(
        workspaceId,
        milestone.id,
        {
          filename: selectedFile.name,
          content_type: selectedFile.type,
          file_size: selectedFile.size,
        }
      );

      const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        body: selectedFile,
        headers: { 'Content-Type': selectedFile.type },
      });

      if (!uploadRes.ok) throw new Error('Upload failed');

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${file_path}`;

      await milestoneService.confirmPhoto(workspaceId, milestone.id, {
        file_path,
        name: selectedFile.name,
        size: selectedFile.size,
        mime_type: selectedFile.type,
      });

      return publicUrl;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) });
      showToast.success('Photo uploaded');
      setShowPhotoModal(false);
      setSelectedFile(null);
    },
    onError: () => showToast.error('Failed to upload photo'),
    onSettled: () => setIsUploading(false),
  });

  const handlePhotoUpload = () => {
    if (!selectedFile) {
      showToast.error('Please select a file');
      return;
    }
    setIsUploading(true);
    uploadPhotoMutation.mutate();
  };

  const photos = milestone.photos || [];
  const milestoneType = MILESTONE_TYPES.find(t => t.value === milestone.milestone_type)?.label || '📌 Custom';

  return (
    <>
      <div className="relative pl-12">
        <div className="absolute left-3.5 top-2 w-3 h-3 rounded-full bg-primary border-2 border-white ring-2 ring-primary-light" />
        <div className="bg-white border border-border rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-text-primary">{milestone.title}</p>
                <span className="text-xs bg-surface-alt px-2 py-0.5 rounded-full text-text-secondary">
                  {milestoneType}
                </span>
              </div>
              <p className="text-xs text-primary font-medium mt-0.5">
                📅 {formatDate(milestone.milestone_date)}
              </p>
              {milestone.description && (
                <p className="text-sm text-text-secondary mt-2">{milestone.description}</p>
              )}
              
              {/* Photos */}
              {photos.length > 0 && (
                <div className="flex gap-2 mt-3 flex-wrap">
                  {photos.map((photo, idx) => (
                    <button
                      key={idx}
                      onClick={() => window.open(photo.url, '_blank')}
                      className="w-16 h-16 rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
                    >
                      {photo.mime_type.startsWith('image/') ? (
                        <img src={photo.url} alt={photo.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-surface-alt">
                          <ImageIcon size={20} className="text-text-secondary" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            {isAdmin && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setShowPhotoModal(true)}
                  className="p-1.5 rounded-lg text-text-secondary hover:text-primary hover:bg-surface-secondary transition-colors"
                  title="Add photo"
                >
                  <ImageIcon size={14} />
                </button>
                <button
                  onClick={() => setShowEditModal(true)}
                  className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-secondary transition-colors"
                  title="Edit milestone"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => {
                    if (confirm('Delete this milestone?')) {
                      milestoneService.delete(workspaceId, milestone.id).then(() => {
                        qc.invalidateQueries({ queryKey: KEYS.timeline(workspaceId) });
                        showToast.success('Milestone deleted');
                        onDelete?.();
                      }).catch(() => showToast.error('Failed to delete'));
                    }
                  }}
                  className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-surface-secondary transition-colors"
                  title="Delete milestone"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Milestone Modal */}
      <Modal open={showEditModal} onClose={() => setShowEditModal(false)} title="Edit Milestone">
        <div className="space-y-4">
          <Input
            label="Title"
            value={editForm.title}
            onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
          />
          <Input
            label="Date"
            type="date"
            value={editForm.milestone_date}
            onChange={(e) => setEditForm({ ...editForm, milestone_date: e.target.value })}
          />
          <Select
            label="Type"
            options={MILESTONE_TYPES}
            value={editForm.milestone_type}
            onChange={(e) => setEditForm({ ...editForm, milestone_type: e.target.value })}
          />
          <Textarea
            label="Description"
            rows={3}
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

      {/* Upload Photo Modal */}
      <Modal open={showPhotoModal} onClose={() => setShowPhotoModal(false)} title="Add Photo to Milestone">
        <div className="space-y-4">
          {selectedFile ? (
            <div className="relative rounded-lg overflow-hidden bg-surface-alt">
              {selectedFile.type.startsWith('image/') ? (
                <img
                  src={URL.createObjectURL(selectedFile)}
                  alt="Preview"
                  className="w-full h-48 object-cover"
                />
              ) : (
                <div className="w-full h-48 flex items-center justify-center bg-surface-alt">
                  <ImageIcon size={32} className="text-text-secondary" />
                </div>
              )}
              <button
                onClick={() => setSelectedFile(null)}
                className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full p-1 transition"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary transition-colors">
              <Upload size={24} className="text-text-secondary mb-1" />
              <span className="text-sm text-text-secondary">Click to select image</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              />
            </label>
          )}
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={() => setShowPhotoModal(false)}>
              Cancel
            </Button>
            <Button fullWidth onClick={handlePhotoUpload} loading={isUploading} disabled={!selectedFile}>
              Upload Photo
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}