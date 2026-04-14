import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ledgerService } from '@/services/ledger.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import showToast from '@/lib/toast';
import { timeAgo } from '@/utils/date';
import { Plus, Receipt } from 'lucide-react';
import type { LedgerEntry } from '@/types/models';
import { LEDGER_STATUSES } from '@/constants/enums';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ApiError } from '@/types/api';

const entrySchema = z.object({ amount: z.coerce.number().positive('Must be positive'), currency: z.string().optional(), notes: z.string().optional() });
type EntryForm = z.infer<typeof entrySchema>;

export default function ContainerLedgerPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showDupe, setShowDupe] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<EntryForm | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<EntryForm>({ resolver: zodResolver(entrySchema) });

  const { data, isLoading } = useQuery({
    queryKey: [...KEYS.ledger(workspaceId, id!), { page, filterStatus }],
    queryFn: () => ledgerService.list(workspaceId, id!, { page, per_page: 20, 'filter[status]': filterStatus || undefined }),
  });
  const entries: LedgerEntry[] = (data as { entries?: LedgerEntry[] })?.entries ?? [];
  const meta = (data as { meta?: { pagination: { total_pages: number } } })?.meta;

  const createMutation = useMutation({
    mutationFn: ({ payload, force }: { payload: EntryForm; force?: boolean }) => ledgerService.create(workspaceId, id!, payload, force),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.ledger(workspaceId, id!) }); qc.invalidateQueries({ queryKey: KEYS.dashboard(workspaceId) }); showToast.success(isAdmin ? 'Contribution confirmed' : 'Submitted — awaiting confirmation'); setShowAdd(false); reset(); },
    onError: (e: unknown) => { const err = e as ApiError; if (err?.status === 409) { setShowDupe(true); } else showToast.error('Failed to record contribution'); },
  });

  const confirmMutation = useMutation({
    mutationFn: (entryId: string) => ledgerService.confirm(workspaceId, id!, entryId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEYS.ledger(workspaceId, id!) }); showToast.success('Confirmed!'); },
    onError: () => showToast.error('Failed to confirm'),
  });

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Ledger</h2>
        <div className="flex items-center gap-2">
          <select className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All status</option>
            {LEDGER_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add</Button>
        </div>
      </div>
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && entries.length === 0 && <EmptyState icon={<Receipt size={36} />} title="No contributions yet" />}
      <div className="space-y-3">
        {entries.map(e => (
          <div key={e.id} className="bg-white border border-border rounded-xl p-4 flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text-primary text-sm truncate">{e.contributor_name}</p>
              <p className="text-xs text-text-secondary mt-0.5"><CurrencyAmount amount={e.amount} currency={e.currency} /> · {timeAgo(e.created_at)}</p>
              {e.notes && <p className="text-xs text-text-secondary mt-1 italic truncate">{e.notes}</p>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Badge status={e.status} />
              {isAdmin && (e.status === 'pending' || e.status === 'proof_uploaded') && (
                <button onClick={() => confirmMutation.mutate(e.id)} disabled={confirmMutation.isPending} className="text-xs text-primary font-semibold hover:underline disabled:opacity-50">Confirm</button>
              )}
            </div>
          </div>
        ))}
      </div>
      <Pagination page={page} totalPages={meta?.pagination?.total_pages ?? 1} onPageChange={setPage} />
      <Modal open={showAdd} onClose={() => { setShowAdd(false); reset(); }} title="Record Contribution">
        <form onSubmit={handleSubmit(p => { setPendingPayload(p); createMutation.mutate({ payload: p }); })} className="space-y-4">
          <Input label="Amount" type="number" placeholder="10000" error={errors.amount?.message} {...register('amount')} />
          <Textarea label="Notes (optional)" placeholder="Payment for..." rows={2} {...register('notes')} />
          <div className="flex gap-3 pt-2"><Button variant="secondary" fullWidth type="button" onClick={() => { setShowAdd(false); reset(); }}>Cancel</Button><Button fullWidth type="submit" loading={createMutation.isPending}>Submit</Button></div>
        </form>
      </Modal>
      <Modal open={showDupe} onClose={() => setShowDupe(false)} title="Possible Duplicate" description="A similar contribution was recorded recently. Submit anyway?">
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth onClick={() => setShowDupe(false)}>Cancel</Button>
          <Button variant="danger" fullWidth onClick={() => { if (pendingPayload) { createMutation.mutate({ payload: pendingPayload, force: true }); setShowDupe(false); } }}>Submit anyway</Button>
        </div>
      </Modal>
    </div>
  );
}
