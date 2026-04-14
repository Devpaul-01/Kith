import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { participantService } from '@/services/participant.service';
import { memberService } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { Modal } from '@/components/ui/Modal';
import { useState } from 'react';
import { Plus, Users } from 'lucide-react';
import showToast from '@/lib/toast';
import type { Participant, WorkspaceMember } from '@/types/models';

export default function ContainerParticipantsPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { data, isLoading } = useQuery({ queryKey: KEYS.participants(workspaceId, id!), queryFn: () => participantService.list(workspaceId, id!) });
  const participants: Participant[] = (data as { participants?: Participant[] })?.participants ?? [];
  const { data: membersData } = useQuery({ queryKey: KEYS.members(workspaceId), queryFn: () => memberService.list(workspaceId) });
  const members: WorkspaceMember[] = (membersData as { members?: WorkspaceMember[] })?.members ?? [];
  const addMutation = useMutation({
    mutationFn: () => participantService.add(workspaceId, id!, { member_ids: selectedIds }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, id!) }); showToast.success('Participants added'); setShowAdd(false); setSelectedIds([]); },
    onError: () => showToast.error('Failed to add participants'),
  });
  const removeMutation = useMutation({
    mutationFn: (pId: string) => participantService.remove(workspaceId, id!, pId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, id!) }); showToast.success('Removed'); },
    onError: () => showToast.error('Failed to remove'),
  });
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-text-primary">Participants</h2><Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add</Button></div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && participants.length === 0 && <EmptyState icon={<Users size={36} />} title="No participants" action={<Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add</Button>} />}
      <div className="space-y-3">
        {participants.map(p => (
          <div key={p.id} className="bg-white border border-border rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3"><Avatar name={p.display_name} size="sm" /><div><p className="font-medium text-text-primary text-sm">{p.display_name}</p>{p.target_amount && <p className="text-xs text-text-secondary">Target: <CurrencyAmount amount={p.target_amount} currency={p.base_currency} /></p>}</div></div>
            <button onClick={() => removeMutation.mutate(p.id)} disabled={removeMutation.isPending} className="text-xs text-danger hover:underline disabled:opacity-50">Remove</button>
          </div>
        ))}
      </div>
      <Modal open={showAdd} onClose={() => { setShowAdd(false); setSelectedIds([]); }} title="Add Participants">
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {members.filter(m => !participants.find(p => p.member_id === m.id)).map(m => (
            <label key={m.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" checked={selectedIds.includes(m.id)} onChange={e => setSelectedIds(prev => e.target.checked ? [...prev, m.id] : prev.filter(i => i !== m.id))} className="rounded" />
              <Avatar name={m.display_name} size="xs" />
              <span className="text-sm text-text-primary">{m.display_name}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-3 pt-4"><Button variant="secondary" fullWidth onClick={() => { setShowAdd(false); setSelectedIds([]); }}>Cancel</Button><Button fullWidth onClick={() => addMutation.mutate()} loading={addMutation.isPending} disabled={selectedIds.length === 0}>Add ({selectedIds.length})</Button></div>
      </Modal>
    </div>
  );
}
