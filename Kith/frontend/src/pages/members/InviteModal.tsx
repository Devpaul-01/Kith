import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inviteService } from '@/services/invite.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// No email or role needed - just create the invite
const schema = z.object({});
type Form = z.infer<typeof schema>;

interface Props { onClose: () => void; }

export function InviteModal({ onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  
  const { handleSubmit } = useForm<Form>({ 
    resolver: zodResolver(schema), 
    defaultValues: {} 
  });
  
  const { mutate, isPending } = useMutation({
    mutationFn: () => inviteService.create(workspaceId), // No payload needed
    onSuccess: (data: { token: string; invite_url: string; expires_at: string }) => {
      setInviteLink(data.invite_url || `${window.location.origin}/invite/${data.token}`);
      qc.invalidateQueries({ queryKey: KEYS.invites(workspaceId) });
      showToast.success('Invite link created!');
    },
    onError: () => showToast.error('Failed to create invite link'),
  });
  
  function copyLink() { 
    navigator.clipboard.writeText(inviteLink); 
    setCopied(true); 
    setTimeout(() => setCopied(false), 2000); 
  }
  
  return (
    <Modal open onClose={onClose} title="Invite Member">
      {!inviteLink ? (
        <form onSubmit={handleSubmit(() => mutate())} className="space-y-4">
          <div className="text-sm text-text-secondary mb-4">
            Generate a shareable link to invite someone to this workspace.
          </div>
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={isPending}>
              Generate Invite Link
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Share this link with the person you want to invite:
          </p>
          <div className="flex gap-2">
            <input 
              readOnly 
              value={inviteLink} 
              className="flex-1 text-xs border border-border rounded-xl px-3 py-2 bg-slate-50 text-text-secondary" 
            />
            <Button variant="secondary" size="sm" onClick={copyLink}>
              {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            </Button>
          </div>
          <Button fullWidth variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}