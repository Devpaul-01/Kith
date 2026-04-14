import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inviteService } from '@/services/invite.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

const schema = z.object({ email: z.string().email().optional().or(z.literal('')), role: z.enum(['admin', 'member']).default('member') });
type Form = z.infer<typeof schema>;

interface Props { onClose: () => void; }
export function InviteModal({ onClose }: Props) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { role: 'member' } });
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => inviteService.create(workspaceId, { email: d.email || undefined, role: d.role }),
    onSuccess: (d: unknown) => { const r = d as { invite?: { token: string } }; if (r?.invite?.token) setInviteLink(`${window.location.origin}/invite/${r.invite.token}`); qc.invalidateQueries({ queryKey: KEYS.invites(workspaceId) }); showToast.success('Invite created!'); },
    onError: () => showToast.error('Failed to create invite'),
  });
  function copyLink() { navigator.clipboard.writeText(inviteLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  return (
    <Modal open onClose={onClose} title="Invite Member">
      {!inviteLink ? (
        <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
          <Input label="Email (optional)" type="email" placeholder="member@example.com" error={errors.email?.message} {...register('email')} />
          <Select label="Role" options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} {...register('role')} />
          <div className="flex gap-3 pt-2"><Button variant="secondary" fullWidth type="button" onClick={onClose}>Cancel</Button><Button fullWidth type="submit" loading={isPending}>Create Invite</Button></div>
        </form>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">Share this link with the person you want to invite:</p>
          <div className="flex gap-2"><input readOnly value={inviteLink} className="flex-1 text-xs border border-border rounded-xl px-3 py-2 bg-slate-50 text-text-secondary" /><Button variant="secondary" size="sm" onClick={copyLink}>{copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}</Button></div>
          <Button fullWidth variant="secondary" onClick={onClose}>Done</Button>
        </div>
      )}
    </Modal>
  );
}
