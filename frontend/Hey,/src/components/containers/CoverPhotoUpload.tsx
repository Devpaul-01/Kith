// components/containers/CoverPhotoUpload.tsx
import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import showToast from '@/lib/toast';
import { Upload, X, Image } from 'lucide-react';

interface CoverPhotoUploadProps {
  workspaceId: string;
  containerId: string;
  currentCoverPhotos?: Array<{ url: string; path: string; uploaded_at?: string }>;
  onSuccess?: () => void;
}

export function CoverPhotoUpload({ 
  workspaceId, 
  containerId, 
  currentCoverPhotos = [], 
  onSuccess 
}: CoverPhotoUploadProps) {
  const [showModal, setShowModal] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const currentCoverUrl = currentCoverPhotos.length > 0 ? currentCoverPhotos[0].url : null;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showToast.error('Please select an image file (JPEG, PNG, WEBP)');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast.error('Image must be less than 5MB');
      return;
    }

    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error('No file selected');

      // Get Supabase URL from environment
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const BUCKET = 'kith-files'; // Your bucket name

      // Step 1: Get upload URL from backend
      // ✅ FIX: Use file_path, not file_url
      const { upload_url, file_path } = await containerService.getCoverPhotoUploadUrl(
        workspaceId,
        containerId,
        {
          filename: selectedFile.name,
          content_type: selectedFile.type,
          file_size: selectedFile.size,
        }
      );

      // Step 2: Upload to presigned URL
      const uploadResponse = await fetch(upload_url, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error('Upload failed');
      }

      // Step 3: Construct the public URL from file_path
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${file_path}`;

      // Step 4: Create new cover photo object
      const newCoverPhoto = {
        url: publicUrl,
        path: file_path,
        uploaded_at: new Date().toISOString(),
      };

      // Step 5: Update container with the new cover photo (replace existing)
      await containerService.update(workspaceId, containerId, {
        cover_photos: [newCoverPhoto],
      });

      return newCoverPhoto;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.container(workspaceId, containerId) });
      showToast.success('Cover photo uploaded successfully');
      setShowModal(false);
      setSelectedFile(null);
      setPreviewUrl(null);
      if (onSuccess) onSuccess();
    },
    onError: (error: any) => {
      const message = error?.message || 'Failed to upload cover photo';
      showToast.error(message);
    },
    onSettled: () => {
      setIsUploading(false);
    },
  });

  const handleUpload = () => {
    if (!selectedFile) {
      showToast.error('Please select a file first');
      return;
    }
    setIsUploading(true);
    uploadMutation.mutate();
  };

  const clearSelection = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <div className="relative rounded-xl overflow-hidden bg-gradient-to-br from-primary/5 to-primary/10 h-32 mb-4">
        {currentCoverUrl ? (
          <>
            <img
              src={currentCoverUrl}
              alt="Container cover"
              className="w-full h-full object-cover"
            />
            <button
              onClick={() => setShowModal(true)}
              className="absolute bottom-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-lg px-3 py-1.5 text-xs flex items-center gap-1 transition"
            >
              <Image size={14} /> Change Cover
            </button>
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-text-secondary">
            <Image size={28} className="mb-1 opacity-50" />
            <button
              onClick={() => setShowModal(true)}
              className="text-sm text-primary hover:underline"
            >
              Add Cover Photo
            </button>
          </div>
        )}
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Upload Cover Photo">
        <div className="space-y-4">
          {previewUrl ? (
            <div className="relative rounded-lg overflow-hidden bg-surface-alt">
              <img
                src={previewUrl}
                alt="Preview"
                className="w-full h-48 object-cover"
              />
              <button
                onClick={clearSelection}
                className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full p-1 transition"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary transition-colors"
            >
              <Upload size={32} className="mx-auto mb-2 text-text-secondary" />
              <p className="text-sm text-text-secondary">Click to select an image</p>
              <p className="text-xs text-text-secondary mt-1">JPEG, PNG, WEBP up to 5MB</p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFileSelect}
          />

          <div className="flex gap-3">
            <Button
              variant="secondary"
              fullWidth
              type="button"
              onClick={() => {
                setShowModal(false);
                clearSelection();
              }}
            >
              Cancel
            </Button>
            <Button
              fullWidth
              onClick={handleUpload}
              disabled={!selectedFile || isUploading}
              loading={isUploading}
            >
              Upload Cover
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}