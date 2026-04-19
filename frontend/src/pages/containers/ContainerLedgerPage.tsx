import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ledgerService } from '@/services/ledger.service';
import { participantService } from '@/services/participant.service';
import { api } from '@/lib/axios';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import showToast from '@/lib/toast';
import { timeAgo } from '@/utils/date';
import {
  AlertTriangle,
  Download,
  Eye,
  GitBranch,
  Pencil,
  Plus,
  Receipt,
  Upload,
} from 'lucide-react';
import type { LedgerEntry, Participant, Workspace, WorkspaceMember } from '@/types/models';
import { LEDGER_STATUSES } from '@/constants/enums';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ApiError } from '@/types/api';

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  contributor_id:    z.string().optional(),
  original_amount:   z.coerce.number().positive('Must be positive'),
  original_currency: z.string().min(1, 'Currency required'),
  note:              z.string().optional(),
  payment_method:    z.string().optional(),
});
type CreateForm = z.infer<typeof createSchema>;

const editSchema = z.object({
  original_amount:   z.coerce.number().positive('Must be positive'),
  original_currency: z.string().min(1, 'Currency required'),
  note:              z.string().optional(),
  payment_method:    z.string().optional(),
  contributor_id:    z.string().optional(),
});
type EditForm = z.infer<typeof editSchema>;

const correctionSchema = z.object({
  original_amount:   z.coerce.number({ required_error: 'Amount required' }),
  original_currency: z.string().min(1, 'Currency required'),
  base_amount:       z.coerce.number({ required_error: 'Base amount required' }),
  note:              z.string().min(1, 'Reason is required for corrections'),
});
type CorrectionForm = z.infer<typeof correctionSchema>;

const disputeSchema = z.object({
  reason: z.string().min(5, 'Please describe the issue (min 5 characters)'),
});
type DisputeForm = z.infer<typeof disputeSchema>;

// ── Constant ──────────────────────────────────────────────────────────────────

const PER_PAGE = 20;

// ── Component ─────────────────────────────────────────────────────────────────

export default function ContainerLedgerPage() {
  const { id: containerId } = useParams<{ id: string }>();
  
  // ✅ Get workspace data correctly
  const { workspaceId, workspace, member } = useWorkspace();
  
  // Extract the values you need
  const memberId = member?.id;  // This is the workspace_member_id
  const isAdmin = member?.role === 'admin';
  const baseCurrency = workspace?.base_currency ?? 'USD';
  
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [filterStatus, setFilterStatus] = useState('');
  const [showAdd, setShowAdd]           = useState(false);
  const [showDupe, setShowDupe]         = useState(false);
  const [pendingCreate, setPending]     = useState<CreateForm | null>(null);
  const [editEntry, setEditEntry]       = useState<LedgerEntry | null>(null);
  const [proofEntry, setProofEntry]     = useState<LedgerEntry | null>(null);
  const [corrEntry, setCorrEntry]       = useState<LedgerEntry | null>(null);
  const [disputeEntry, setDisputeEntry] = useState<LedgerEntry | null>(null);
  const [uploadFile, setUploadFile]     = useState<File | null>(null);
  const [isUploading, setUploading]     = useState(false);

  // ── Forms ─────────────────────────────────────────────────────────────────
  const createForm = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      original_currency: baseCurrency ?? 'USD',
    },
  });
  const editForm    = useForm<EditForm>({ resolver: zodResolver(editSchema) });
  const corrForm    = useForm<CorrectionForm>({ resolver: zodResolver(correctionSchema) });
  const disputeForm = useForm<DisputeForm>({ resolver: zodResolver(disputeSchema) });

  // ── FIX (non-admin): sync contributor_id when memberId becomes available ──
  useEffect(() => {
    if (!isAdmin && memberId) {
      createForm.setValue('contributor_id', memberId);
    }
  }, [memberId, isAdmin]);

  // ── Infinite ledger query ─────────────────────────────────────────────────
  const {
    data,
    isLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = useInfiniteQuery({
    queryKey: [...KEYS.ledger(workspaceId, containerId!), { filterStatus }],
    queryFn: ({ pageParam = 1 }) =>
      ledgerService.list(workspaceId, containerId!, {
        page:             pageParam,
        per_page:         PER_PAGE,
        'filter[status]': filterStatus || undefined,
      }),
    getNextPageParam: (lastPage: any) => {
      const p = lastPage?.meta?.pagination;
      if (!p) return undefined;
      const totalPages = Math.ceil((p.total ?? 0) / (p.per_page ?? PER_PAGE));
      return p.page < totalPages ? p.page + 1 : undefined;
    },
    initialPageParam: 1,
  });

  const entries: LedgerEntry[] =
    data?.pages.flatMap((page: any) => page?.entries ?? []) ?? [];
  const totalCount: number =
    (data?.pages[0] as any)?.meta?.pagination?.total ?? 0;


  
  // ── Participants query (admin only) ───────────────────────────────────────
const { data: participantsData, isLoading: participantsLoading } = useQuery({
  queryKey: [...KEYS.participants(workspaceId, containerId!)],
  queryFn: () => participantService.list(workspaceId, containerId!),
  enabled: isAdmin,
});
const participants: Participant[] = (participantsData as any)?.participants ?? [];
const moneyEnabledParticipants = participants.filter(p => p.money_enabled);

  // ── FIX (admin): sync contributor_id to first valid participant ───────────
  useEffect(() => {
    if (!isAdmin || !showAdd || moneyEnabledParticipants.length === 0) return;
    const currentVal = createForm.getValues('contributor_id');
    const validIds   = moneyEnabledParticipants.map(p => p.workspace_member_id);
    if (!currentVal || !validIds.includes(currentVal)) {
      createForm.setValue('contributor_id', moneyEnabledParticipants[0].workspace_member_id);
    }
  }, [isAdmin, showAdd, moneyEnabledParticipants.length]);

  // ── Cache invalidation ────────────────────────────────────────────────────
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEYS.ledger(workspaceId, containerId!) });
    qc.invalidateQueries({ queryKey: KEYS.dashboard(workspaceId) });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: ({ payload, force }: { payload: CreateForm; force?: boolean }) => {
      // For non-admins: use memberId, for admins: use selected contributor
      const requestPayload = isAdmin
        ? {
            entry_type: 'contribution',
            contributor_id: payload.contributor_id,
            original_amount: payload.original_amount,
            original_currency: payload.original_currency,
            base_amount: payload.original_amount,
            payment_method: payload.payment_method || null,
            note: payload.note || null,
            is_crypto: false,
          }
        : {
            entry_type: 'contribution',
            contributor_id: memberId,  // Non-admin always contributes as themselves
            original_amount: payload.original_amount,
            original_currency: payload.original_currency,
            base_amount: payload.original_amount,
            payment_method: payload.payment_method || null,
            note: payload.note || null,
            is_crypto: false,
          };

      return ledgerService.create(workspaceId, containerId!, requestPayload, force);
    },
    onSuccess: () => {
      invalidate();
      showToast.success(
        isAdmin ? 'Contribution confirmed' : 'Submitted — awaiting admin confirmation',
      );
      setShowAdd(false);
      createForm.reset({ original_currency: baseCurrency ?? 'USD' });
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      if (err?.status === 409) {
        setShowDupe(true);
      } else {
        const errorData = err as any;
        const msg = 
          errorData?.data?.error?.message ||
          errorData?.message ||
          errorData?.data?.message ||
          'Failed to record contribution';
        
        showToast.error(msg);
        console.error('Contribution error:', errorData?.data?.error || errorData);
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ entryId, payload }: { entryId: string; payload: EditForm }) =>
      ledgerService.update(workspaceId, containerId!, entryId, {
        original_amount:   payload.original_amount,
        original_currency: payload.original_currency,
        note:              payload.note || null,
        payment_method:    payload.payment_method || null,
        ...(isAdmin && payload.contributor_id
          ? { contributor_id: payload.contributor_id }
          : {}),
      }),
    onSuccess: () => { 
      invalidate(); 
      showToast.success('Entry updated'); 
      setEditEntry(null); 
    },
    onError: () => showToast.error('Failed to update entry'),
  });

  const confirmMutation = useMutation({
    mutationFn: (entryId: string) =>
      ledgerService.confirm(workspaceId, containerId!, entryId),
    onSuccess: () => { 
      invalidate(); 
      showToast.success('Entry confirmed!'); 
    },
    onError: () => showToast.error('Failed to confirm entry'),
  });

  const corrMutation = useMutation({
    mutationFn: ({ entryId, payload }: { entryId: string; payload: CorrectionForm }) =>
      ledgerService.addCorrection(workspaceId, containerId!, entryId, payload),
    onSuccess: () => {
      invalidate();
      showToast.success('Correction applied');
      setCorrEntry(null);
      corrForm.reset();
    },
    onError: () => showToast.error('Failed to add correction'),
  });

  const disputeMutation = useMutation({
    mutationFn: ({ entryId, reason }: { entryId: string; reason: string }) =>
      api
        .post(
          `/v1/workspaces/${workspaceId}/containers/${containerId}/ledger/${entryId}/dispute`,
          { reason },
        )
        .then(r => r.data),
    onSuccess: () => {
      invalidate();
      showToast.success('Dispute raised — admins have been notified');
      setDisputeEntry(null);
      disputeForm.reset();
    },
    onError: () => showToast.error('Failed to raise dispute'),
  });

  // ── Proof upload: signed URL → PUT to storage → confirm ──────────────────
  const handleProofUpload = async () => {
    if (!proofEntry || !uploadFile) return;
    setUploading(true);
    try {
      const { upload_url, file_path } = await ledgerService.getUploadProofUrl(
        workspaceId, containerId!, proofEntry.id,
        { filename: uploadFile.name, content_type: uploadFile.type, file_size: uploadFile.size },
      );
      await fetch(upload_url, {
        method: 'PUT', 
        headers: { 'Content-Type': uploadFile.type }, 
        body: uploadFile,
      });
      await ledgerService.confirmProof(workspaceId, containerId!, proofEntry.id, {
        file_path, 
        name: uploadFile.name, 
        size: uploadFile.size, 
        mime_type: uploadFile.type,
      });
      invalidate();
      showToast.success('Proof uploaded');
      setProofEntry(null);
      setUploadFile(null);
    } catch {
      showToast.error('Failed to upload proof');
    } finally {
      setUploading(false);
    }
  };

  // ── View proof ────────────────────────────────────────────────────────────
  const handleViewProof = async (entry: LedgerEntry, fileIndex = 0) => {
    try {
      const { url } = await ledgerService.getProofUrl(
        workspaceId, containerId!, entry.id, fileIndex,
      );
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      showToast.error('Could not load proof');
    }
  };

  // ── Export CSV ────────────────────────────────────────────────────────────
  const handleExport = async () => {
    try {
      const csv = await ledgerService.export(workspaceId, { container_id: containerId });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      Object.assign(document.createElement('a'), {
        href: url, 
        download: `ledger-${containerId}-${Date.now()}.csv`,
      }).click();
      URL.revokeObjectURL(url);
    } catch {
      showToast.error('Export failed');
    }
  };

  // ── Open edit modal pre-filled ────────────────────────────────────────────
  const openEdit = (entry: LedgerEntry) => {
    editForm.reset({
      original_amount:   entry.original_amount,
      original_currency: entry.original_currency,
      note:              entry.note ?? '',
      payment_method:    entry.payment_method ?? '',
      contributor_id:    entry.contributor_id,
    });
    setEditEntry(entry);
  };

  // ── Per-entry capability flags ────────────────────────────────────────────
  const canEdit = (e: LedgerEntry) =>
    e.status === 'pending' && (isAdmin || e.contributor_id === memberId);

  const canUploadProof = (e: LedgerEntry) =>
    (e.status === 'pending' || e.status === 'proof_uploaded') &&
    (isAdmin || e.contributor_id === memberId);

  const canConfirm = (e: LedgerEntry) =>
    isAdmin && (e.status === 'pending' || e.status === 'proof_uploaded');

  const canDispute = (e: LedgerEntry) =>
    e.status === 'confirmed' && (isAdmin || e.contributor_id === memberId);
    return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-text-primary">Ledger</h2>
          {totalCount > 0 && (
            <span className="text-xs text-text-secondary">({totalCount} total)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-xs border border-border rounded-lg px-2 py-1.5 bg-white focus:outline-none max-w-[130px]"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {LEDGER_STATUSES.map(s => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>

          {isAdmin && (
            <button
              title="Export CSV"
              onClick={handleExport}
              className="p-1.5 rounded-lg border border-border text-text-secondary hover:text-primary hover:border-primary transition-colors"
            >
              <Download size={14} />
            </button>
          )}

          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add
          </Button>
        </div>
      </div>

      {/* ── Loading ── */}
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}

      {/* ── Empty ── */}
      {!isLoading && entries.length === 0 && (
        <EmptyState
          icon={<Receipt size={36} />}
          title="No contributions yet"
          description={
            filterStatus
              ? `No entries with status "${filterStatus.replace(/_/g, ' ')}"`
              : 'Record the first contribution to get started.'
          }
        />
      )}

      {/* ── Entry list ── */}
      <div className="space-y-3">
        {entries.map(entry => {
          const hasProofs = (entry.proofs?.length ?? 0) > 0;

          return (
            <div
              key={entry.id}
              className="bg-white border border-border rounded-xl p-4 flex items-center justify-between gap-3"
            >
              {/* Left */}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-text-primary text-sm truncate">
                  {entry.contributor_name ?? '—'}
                </p>
                <p className="text-xs text-text-secondary mt-0.5">
                  <CurrencyAmount amount={entry.original_amount} currency={entry.original_currency} />
                  {' · '}
                  {timeAgo(entry.recorded_at ?? entry.created_at)}
                  {entry.recorded_by_name && entry.recorded_by_name !== entry.contributor_name && (
                    <> · by {entry.recorded_by_name}</>
                  )}
                </p>
                {entry.note && (
                  <p className="text-xs text-text-secondary mt-1 italic truncate">{entry.note}</p>
                )}
                {entry.confirmed_by_name && (
                  <p className="text-xs text-emerald-600 mt-0.5">
                    ✓ confirmed by {entry.confirmed_by_name}
                  </p>
                )}
              </div>

              {/* Right: badge + actions */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge status={entry.status} />

                {canConfirm(entry) && (
                  <button
                    onClick={() => confirmMutation.mutate(entry.id)}
                    disabled={confirmMutation.isPending}
                    className="text-xs text-primary font-semibold hover:underline disabled:opacity-50 whitespace-nowrap"
                  >
                    Confirm
                  </button>
                )}

                {canEdit(entry) && (
                  <button 
                    title="Edit entry" 
                    onClick={() => openEdit(entry)}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                )}

                {canUploadProof(entry) && (
                  <button 
                    title="Upload proof"
                    onClick={() => { setProofEntry(entry); setUploadFile(null); }}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Upload size={14} />
                  </button>
                )}

                {hasProofs && (isAdmin || entry.contributor_id === memberId) && (
                  <button
                    title={`View proof${entry.proofs!.length > 1 ? ` (${entry.proofs!.length})` : ''}`}
                    onClick={() => handleViewProof(entry)}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Eye size={14} />
                  </button>
                )}

                {canDispute(entry) && (
                  <button
                    title="Raise dispute"
                    onClick={() => { disputeForm.reset(); setDisputeEntry(entry); }}
                    className="text-text-secondary hover:text-amber-500 transition-colors"
                  >
                    <AlertTriangle size={14} />
                  </button>
                )}

                {isAdmin && (
                  <button 
                    title="Add correction"
                    onClick={() => { corrForm.reset({ original_currency: entry.original_currency }); setCorrEntry(entry); }}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <GitBranch size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Load more ── */}
      {(hasNextPage || isFetchingNextPage) && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchNextPage()}
            loading={isFetchingNextPage}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
        {/* ═══════════════════════ MODALS ════════════════════════════════════ */}

      {/* ── Add Contribution ── */}
      <Modal
        open={showAdd}
        onClose={() => { setShowAdd(false); createForm.reset({ original_currency: baseCurrency ?? 'USD' }); }}
        title="Record Contribution"
      >
        <form
          onSubmit={createForm.handleSubmit(p => { setPending(p); createMutation.mutate({ payload: p }); })}
          className="space-y-4"
        >
          {isAdmin && (
  <div className="flex flex-col gap-1">
    <label className="text-xs font-medium text-text-secondary">Recording for</label>
    {participantsLoading ? (
      <div className="flex items-center justify-center py-2">
        <Spinner size="sm" />
      </div>
    ) : moneyEnabledParticipants.length === 0 ? (
      <div className="text-sm text-text-secondary bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
        ⚠️ No participants with money tracking enabled. 
        <Link to={`/app/containers/${containerId}/participants`} className="text-primary underline ml-1">
          Add participants first
        </Link>
      </div>
    ) : (
      <select
        className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
        {...createForm.register('contributor_id')}
      >
        {moneyEnabledParticipants.map(p => (
          <option key={p.workspace_member_id} value={p.workspace_member_id}>
            {p.display_name}
          </option>
        ))}
      </select>
    )}
  </div>
)}

          <Input 
            label="Amount" 
            type="number" 
            step="0.01" 
            placeholder="10000"
            error={createForm.formState.errors.original_amount?.message}
            {...createForm.register('original_amount')} 
          />
          <Input 
            label="Currency" 
            placeholder="USD"
            error={createForm.formState.errors.original_currency?.message}
            {...createForm.register('original_currency')} 
          />
          <div className="flex flex-col gap-1">
  <label className="text-xs font-medium text-text-secondary">
    Payment method (optional)
  </label>
  <select
    className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
    {...createForm.register('payment_method')}
  >
    <option value="">Select payment method</option>
    <option value="cash">Cash</option>
    <option value="bank_transfer">Bank Transfer</option>
    <option value="mobile_money">Mobile Money</option>
    <option value="crypto">Crypto</option>
    <option value="other">Other</option>
  </select>
</div>
          <Textarea 
            label="Notes (optional)" 
            placeholder="Payment for…" 
            rows={2}
            {...createForm.register('note')} 
          />

          <div className="flex gap-3 pt-2">
            <Button 
              variant="secondary" 
              fullWidth 
              type="button"
              onClick={() => { setShowAdd(false); createForm.reset({ original_currency: baseCurrency ?? 'USD' }); }}
            >
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={createMutation.isPending}>Submit</Button>
          </div>
        </form>
      </Modal>

      {/* ── Duplicate warning ── */}
      <Modal 
        open={showDupe} 
        onClose={() => setShowDupe(false)} 
        title="Possible Duplicate"
        description="A similar contribution was recorded within the last 10 minutes. Submit anyway?"
      >
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" fullWidth onClick={() => setShowDupe(false)}>Cancel</Button>
          <Button 
            variant="danger" 
            fullWidth
            onClick={() => { 
              if (pendingCreate) { 
                createMutation.mutate({ payload: pendingCreate, force: true }); 
                setShowDupe(false); 
              } 
            }}
          >
            Submit anyway
          </Button>
        </div>
      </Modal>

      {/* ── Edit entry ── */}
      <Modal open={!!editEntry} onClose={() => setEditEntry(null)} title="Edit Entry">
        <form
          onSubmit={editForm.handleSubmit(p => editEntry && updateMutation.mutate({ entryId: editEntry.id, payload: p }))}
          className="space-y-4"
        >
          {isAdmin && moneyEnabledParticipants.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-text-secondary">Contributor</label>
              <select 
                className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
                {...editForm.register('contributor_id')}
              >
                {moneyEnabledParticipants.map(p => (
                  <option key={p.workspace_member_id} value={p.workspace_member_id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Input 
            label="Amount" 
            type="number" 
            step="0.01"
            error={editForm.formState.errors.original_amount?.message}
            {...editForm.register('original_amount')} 
          />
          <Input 
            label="Currency"
            error={editForm.formState.errors.original_currency?.message}
            {...editForm.register('original_currency')} 
          />
          <div className="flex flex-col gap-1">
  <label className="text-xs font-medium text-text-secondary">
    Payment method (optional)
  </label>
  <select
    className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
    {...editForm.register('payment_method')}
  >
    <option value="">Select payment method</option>
    <option value="cash">Cash</option>
    <option value="bank_transfer">Bank Transfer</option>
    <option value="mobile_money">Mobile Money</option>
    <option value="crypto">Crypto</option>
    <option value="other">Other</option>
  </select>
</div>
          <Textarea 
            label="Notes (optional)" 
            rows={2} 
            {...editForm.register('note')} 
          />

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={() => setEditEntry(null)}>Cancel</Button>
            <Button fullWidth type="submit" loading={updateMutation.isPending}>Save changes</Button>
          </div>
        </form>
      </Modal>

      {/* ── Upload proof ── */}
      <Modal
        open={!!proofEntry}
        onClose={() => { setProofEntry(null); setUploadFile(null); }}
        title="Upload Proof"
        description="Accepted formats: images (JPEG, PNG, WEBP) and PDF."
      >
        <div className="space-y-4">
          <input 
            ref={fileRef} 
            type="file" 
            accept="image/*,application/pdf" 
            className="hidden"
            onChange={e => setUploadFile(e.target.files?.[0] ?? null)} 
          />

          {uploadFile ? (
            <div className="text-sm text-text-secondary border border-border rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="truncate">{uploadFile.name}</span>
              <button 
                onClick={() => setUploadFile(null)} 
                className="text-xs text-destructive ml-2 shrink-0"
              >
                Remove
              </button>
            </div>
          ) : (
            <Button variant="secondary" fullWidth onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> Choose file
            </Button>
          )}

          <div className="flex gap-3 pt-2">
            <Button 
              variant="secondary" 
              fullWidth 
              onClick={() => { setProofEntry(null); setUploadFile(null); }}
            >
              Cancel
            </Button>
            <Button 
              fullWidth 
              onClick={handleProofUpload} 
              loading={isUploading} 
              disabled={!uploadFile}
            >
              Upload
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Raise Dispute ── */}
      <Modal
        open={!!disputeEntry}
        onClose={() => { setDisputeEntry(null); disputeForm.reset(); }}
        title="Raise a Dispute"
        description={
          disputeEntry
            ? `Disputing contribution of ${disputeEntry.original_amount} ${disputeEntry.original_currency}. Admins will be notified to review.`
            : undefined
        }
      >
        <form
          onSubmit={disputeForm.handleSubmit(p =>
            disputeEntry && disputeMutation.mutate({ entryId: disputeEntry.id, reason: p.reason }),
          )}
          className="space-y-4"
        >
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700">
              Use this only if you believe the amount or status is incorrect.
              Disputes are visible to all workspace admins.
            </p>
          </div>

          <Textarea
            label="Reason for dispute"
            placeholder="Explain what is incorrect and what the correct value should be…"
            rows={3}
            error={disputeForm.formState.errors.reason?.message}
            {...disputeForm.register('reason')}
          />

          <div className="flex gap-3 pt-2">
            <Button 
              variant="secondary" 
              fullWidth 
              type="button"
              onClick={() => { setDisputeEntry(null); disputeForm.reset(); }}
            >
              Cancel
            </Button>
            <Button 
              variant="danger" 
              fullWidth 
              type="submit" 
              loading={disputeMutation.isPending}
            >
              Submit dispute
            </Button>
          </div>
        </form>
      </Modal>

      {/* ── Add correction (admin only) ── */}
      <Modal
        open={!!corrEntry}
        onClose={() => { setCorrEntry(null); corrForm.reset(); }}
        title="Add Correction"
      >
        <form
          onSubmit={corrForm.handleSubmit(p => corrEntry && corrMutation.mutate({ entryId: corrEntry.id, payload: p }))}
          className="space-y-4"
        >
          <p className="text-xs text-text-secondary bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Enter a <strong>positive</strong> amount representing the corrected value.
            Corrections are auto-confirmed and permanently linked to the original entry.
            To offset an over-payment, enter the excess amount as a correction with a descriptive note.
          </p>

          <Input 
            label="Correction amount" 
            type="number" 
            step="0.01" 
            placeholder="-5000 or 2500"
            error={corrForm.formState.errors.original_amount?.message}
            {...corrForm.register('original_amount')} 
          />
          <Input 
            label="Currency"
            error={corrForm.formState.errors.original_currency?.message}
            {...corrForm.register('original_currency')} 
          />
          <Input 
            label="Base amount (in workspace currency)" 
            type="number" 
            step="0.01"
            error={corrForm.formState.errors.base_amount?.message}
            {...corrForm.register('base_amount')} 
          />
          <Textarea 
            label="Reason (required)" 
            rows={2} 
            placeholder="Explain why this correction is being made…"
            error={corrForm.formState.errors.note?.message}
            {...corrForm.register('note')} 
          />

          <div className="flex gap-3 pt-2">
            <Button 
              variant="secondary" 
              fullWidth 
              type="button"
              onClick={() => { setCorrEntry(null); corrForm.reset(); }}
            >
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={corrMutation.isPending}>Apply correction</Button>
          </div>
        </form>
      </Modal>

    </div>
  );
}

