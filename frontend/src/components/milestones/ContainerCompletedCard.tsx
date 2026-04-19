// components/milestones/ContainerCompletedCard.tsx
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatDate } from '@/utils/date';
import { Image as ImageIcon, FileText } from 'lucide-react';
import type { TimelineItem } from '@/services/milestone.service';

interface ContainerCompletedCardProps {
  item: TimelineItem;
}

export function ContainerCompletedCard({ item }: ContainerCompletedCardProps) {
  const [showFilesModal, setShowFilesModal] = useState(false);
  const photos = item.photos || [];

  const isImage = (mimeType: string) => mimeType.startsWith('image/');

  return (
    <>
      <div className="relative pl-12">
        <div className="absolute left-3.5 top-2 w-3 h-3 rounded-full bg-success border-2 border-white ring-2 ring-success/30" />
        <div className="bg-white border border-border rounded-xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-text-primary">{item.title}</p>
                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                  ✓ Completed
                </span>
              </div>
              <p className="text-xs text-success font-medium mt-0.5">
                📅 Completed on {formatDate(item.date)}
              </p>
              {item.description && (
                <p className="text-sm text-text-secondary mt-2">{item.description}</p>
              )}
              
              {/* Outcome Files */}
              {photos.length > 0 && (
                <div className="mt-3">
                  <button
                    onClick={() => setShowFilesModal(true)}
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <FileText size={12} /> View {photos.length} outcome file{photos.length !== 1 ? 's' : ''}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Outcome Files Modal */}
      <Modal open={showFilesModal} onClose={() => setShowFilesModal(false)} title="Outcome Files">
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {photos.map((file, idx) => (
            <div
              key={idx}
              className="border border-border rounded-lg overflow-hidden cursor-pointer hover:border-primary transition-colors"
              onClick={() => window.open(file.url, '_blank')}
            >
              {isImage(file.mime_type) ? (
                <img src={file.url} alt={file.name} className="w-full h-48 object-cover" />
              ) : (
                <div className="flex items-center gap-3 p-4 bg-surface-alt">
                  <FileText size={24} className="text-text-secondary" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-text-primary">{file.name}</p>
                    <p className="text-xs text-text-secondary">
                      {(file.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}