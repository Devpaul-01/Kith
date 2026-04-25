// components/workspace/InviteModal.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/axios';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import showToast from '@/lib/toast';
import { Copy, Check, Trash2, RefreshCw } from 'lucide-react';

interface Invite {
  id: string;
  token: string;
  created_by_name: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface InviteModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

export function InviteModal({ open, onClose, workspaceId }: InviteModalProps) {
  const qc = useQueryClient();
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const { data: invitesData, isLoading } = useQuery({
    queryKey: ['invites', workspaceId],
    queryFn: () => api.get(`/v1/workspaces/${workspaceId}/invites`).then(r => r.data),
    enabled: open,
  });

  const invites: Invite[] = invitesData?.invites || [];

  const createInviteMutation = useMutation({
    mutationFn: () => api.post(`/v1/workspaces/${workspaceId}/invites`),
    onSuccess: (response) => {
      qc.invalidateQueries({ queryKey: ['invites', workspaceId] });
      const inviteUrl = response.data.invite_url;
      navigator.clipboard.writeText(inviteUrl);
      showToast.success('Invite link created and copied to clipboard!');
    },
    onError: () => showToast.error('Failed to create invite link'),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => api.delete(`/v1/workspaces/${workspaceId}/invites/${inviteId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites', workspaceId] });
      showToast.success('Invite link revoked');
    },
    onError: () => showToast.error('Failed to revoke invite'),
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(text);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

  const isExpired = (expiresAt: string) => {
    return new Date(expiresAt) < new Date();
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite Members" size="lg">
      <div className="space-y-5">
        {/* Create Invite Button */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-primary font-medium">Invite new members</p>
            <p className="text-xs text-text-secondary">Share a link to invite people to this workspace</p>
          </div>
          <Button
            size="sm"
            onClick={() => createInviteMutation.mutate()}
            loading={createInviteMutation.isPending}
          >
            <RefreshCw size={14} className="mr-1" /> Create Link
          </Button>
        </div>

        {/* Active Invites List */}
        <div>
          <h3 className="text-sm font-medium text-text-primary mb-3">Active Invites</h3>
          
          {isLoading && (
            <div className="flex justify-center py-4">
              <Spinner size="sm" />
            </div>
          )}

          {!isLoading && invites.length === 0 && (
            <div className="text-center py-6 text-text-secondary border border-dashed border-border rounded-lg">
              <p className="text-sm">No active invites</p>
              <p className="text-xs mt-1">Create an invite link to share with others</p>
            </div>
          )}

          <div className="space-y-3">
            {invites.map((invite) => {
              const expired = isExpired(invite.expires_at);
              const inviteUrl = `${window.location.origin}/invite/${invite.token}`;
              
              return (
                <div
                  key={invite.id}
                  className={`border rounded-lg p-3 ${expired ? 'border-danger/30 bg-danger/5' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-text-primary truncate">{invite.token}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-text-secondary flex-wrap">
                        <span>Created by {invite.created_by_name}</span>
                        <span>Expires {formatDate(invite.expires_at)}</span>
                        {invite.used_at && (
                          <span className="text-success">✓ Used on {formatDate(invite.used_at)}</span>
                        )}
                        {expired && !invite.used_at && (
                          <span className="text-danger">Expired</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {!expired && !invite.used_at && (
                        <button
                          onClick={() => copyToClipboard(inviteUrl)}
                          className="p-1.5 rounded-lg text-text-secondary hover:text-primary hover:bg-surface transition-colors"
                          title="Copy invite link"
                        >
                          {copiedToken === invite.token ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm('Revoke this invite link? It will no longer work.')) {
                            revokeInviteMutation.mutate(invite.id);
                          }
                        }}
                        disabled={revokeInviteMutation.isPending}
                        className="p-1.5 rounded-lg text-text-secondary hover:text-danger hover:bg-red-50 transition-colors disabled:opacity-50"
                        title="Revoke invite"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Info Box */}
        <div className="rounded-lg bg-surface-alt p-3">
          <p className="text-xs text-text-secondary">
            🔗 Anyone with an invite link can join this workspace. Links expire after 7 days.
            You can revoke any link at any time.
          </p>
        </div>
      </div>
    </Modal>
  );
}