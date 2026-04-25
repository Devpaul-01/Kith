import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { disputeService } from '@/services/dispute.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Textarea } from '@/components/ui/Textarea';
import { Card } from '@/components/ui/Card';
import { timeAgo } from '@/utils/date';
import showToast from '@/lib/toast';
import { useState } from 'react';
import type { Dispute, DisputeNote } from '@/types/models';

export default function DisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: KEYS.dispute(workspaceId, id!), queryFn: () => disputeService.get(workspaceId, id!) });
  const dispute: Dispute | undefined = (data as { dispute?: Dispute })?.dispute;
  const addNote = useMutation({ mutationFn: () => disputeService.addNote(workspaceId, id!, { note }), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.dispute(workspaceId, id!) }); setNote(''); showToast.success('Note added'); }, onError: () => showToast.error('Failed') });
  const resolve = useMutation({ mutationFn: () => disputeService.resolve(workspaceId, id!, { resolution_note: resolution }), onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.dispute(workspaceId, id!) }); qc.invalidateQueries({ queryKey: KEYS.disputes(workspaceId) }); setShowResolve(false); showToast.success('Resolved'); }, onError: () => showToast.error('Failed') });
  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!dispute) return <div className="p-6 text-center text-text-secondary">Not found.</div>;
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3"><h1 className="text-xl font-bold text-text-primary">Dispute</h1><Badge status={dispute.status} /></div>
      <Card className="space-y-3">
        <div><p className="text-xs text-text-secondary">Raised by</p><p className="font-medium text-text-primary">{dispute.raised_by_name}</p></div>
        <div><p className="text-xs text-text-secondary">Reason</p><p className="text-sm text-text-primary">{dispute.reason}</p></div>
        <div><p className="text-xs text-text-secondary">Filed</p><p className="text-sm text-text-secondary">{timeAgo(dispute.created_at)}</p></div>
        {dispute.resolution_note && <div className="bg-green-50 rounded-xl p-3"><p className="text-xs text-green-600 font-semibold">Resolution</p><p className="text-sm text-green-800 mt-1">{dispute.resolution_note}</p></div>}
      </Card>
      {dispute.notes && dispute.notes.length > 0 && (
        <Card><h3 className="font-semibold text-text-primary mb-3 text-sm">Notes</h3><div className="space-y-3">{dispute.notes.map((n: DisputeNote) => (<div key={n.id} className="border-b border-border pb-3 last:border-0 last:pb-0"><div className="flex justify-between text-xs text-text-secondary mb-1"><span className="font-medium">{n.member_name}</span><span>{timeAgo(n.created_at)}</span></div><p className="text-sm text-text-primary">{n.note}</p></div>))}</div></Card>
      )}
      {dispute.status === 'open' && (
        <Card className="space-y-3">
          <Textarea label="Add note" placeholder="Add context..." rows={3} value={note} onChange={e => setNote(e.target.value)} />
          <div className="flex gap-3"><Button variant="secondary" fullWidth onClick={() => addNote.mutate()} disabled={!note.trim()} loading={addNote.isPending}>Add Note</Button>{isAdmin && <Button variant="danger" fullWidth onClick={() => setShowResolve(s => !s)}>Resolve</Button>}</div>
          {showResolve && isAdmin && <div className="space-y-3 pt-2 border-t border-border"><Textarea label="Resolution note" placeholder="How was this resolved?" rows={3} value={resolution} onChange={e => setResolution(e.target.value)} /><Button fullWidth onClick={() => resolve.mutate()} disabled={!resolution.trim()} loading={resolve.isPending}>Confirm Resolution</Button></div>}
        </Card>
      )}
    </div>
  );
}
