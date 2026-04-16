import { useState, useRef } from 'react';
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
import { Plus, Receipt, Download, Pencil, Upload, Eye, GitBranch } from 'lucide-react';
import type { LedgerEntry } from '@/types/models';
import { LEDGER_STATUSES } from '@/constants/enums';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ApiError } from '@/types/api';

// ── Schemas ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
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
});
type EditForm = z.infer<typeof editSchema>;

const correctionSchema = z.object({
  original_amount:   z.coerce.number({ required_error: 'Amount required' }),
  original_currency: z.string().min(1, 'Currency required'),
  base_amount:       z.coerce.number({ required_error: 'Base amount required' }),
  note:              z.string().min(1, 'Note is required for corrections'),
});
type CorrectionForm = z.infer<typeof correctionSchema>;

// ── Component ─────────────────────────────────────────────────────────────────

export default function ContainerLedgerPage() {
  const { id: containerId } = useParams<{ id: string }>();
  // TODO: confirm useWorkspace exposes memberId and baseCurrency alongside workspaceId.
  // memberId is needed as contributor_id when creating an entry.
  const { workspaceId, member } = useWorkspace();
  
  const memberId = member?.id ?? null;
  const isAdmin = useIsAdmin();
  const qc      = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  // ── UI state ──
  const [page, setPage]               = useState(1);
  const [filterStatus, setFilter]     = useState('');
  const [showAdd, setShowAdd]         = useState(false);
  const [showDupe, setShowDupe]       = useState(false);
  const [pendingCreate, setPending]   = useState<CreateForm | null>(null);
  const [editEntry, setEditEntry]     = useState<LedgerEntry | null>(null);
  const [proofEntry, setProofEntry]   = useState<LedgerEntry | null>(null);
  const [corrEntry, setCorrEntry]     = useState<LedgerEntry | null>(null);
  const [uploadFile, setUploadFile]   = useState<File | null>(null);
  const [isUploading, setUploading]   = useState(false);

  // ── Forms ──
  const createForm = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { original_currency: 'USD' },
  });
  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) });
  const corrForm = useForm<CorrectionForm>({ resolver: zodResolver(correctionSchema) });

  // ── Query ──
  const { data, isLoading } = useQuery({
    queryKey: [...KEYS.ledger(workspaceId, containerId!), { page, filterStatus }],
    queryFn: () =>
      ledgerService.list(workspaceId, containerId!, {
        page,
        per_page: 20,
        'filter[status]': filterStatus || undefined,
      }),
  });
  const entries: LedgerEntry[] = (data as any)?.entries ?? [];
  const meta                   = (data as any)?.meta;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEYS.ledger(workspaceId, containerId!) });
    qc.invalidateQueries({ queryKey: KEYS.dashboard(workspaceId) });
  };

  // ── Mutations ──
  const createMutation = useMutation({
    mutationFn: ({ payload, force }: { payload: CreateForm; force?: boolean }) =>
      ledgerService.create(
        workspaceId,
        containerId!,
        {
          ...payload,
          entry_type:    'contribution',
          contributor_id: memberId,           // always own ID for non-admin; admin can extend later
          base_amount:   payload.original_amount, // TODO: apply FX rate if original_currency ≠ baseCurrency
        },
        force,
      ),
    onSuccess: () => {
      invalidate();
      showToast.success(isAdmin ? 'Contribution confirmed' : 'Submitted — awaiting confirmation');
      setShowAdd(false);
      createForm.reset();
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      if (err?.status === 409) setShowDupe(true);
      else showToast.error('Failed to record contribution');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ entryId, payload }: { entryId: string; payload: EditForm }) =>
      ledgerService.update(workspaceId, containerId!, entryId, payload),
    onSuccess: () => {
      invalidate();
      showToast.success('Entry updated');
      setEditEntry(null);
    },
    onError: () => showToast.error('Failed to update entry'),
  });

  const confirmMutation = useMutation({
    mutationFn: (entryId: string) => ledgerService.confirm(workspaceId, containerId!, entryId),
    onSuccess: () => { invalidate(); showToast.success('Confirmed!'); },
    onError:   () => showToast.error('Failed to confirm'),
  });

  const corrMutation = useMutation({
    mutationFn: ({ entryId, payload }: { entryId: string; payload: CorrectionForm }) =>
      ledgerService.addCorrection(workspaceId, containerId!, entryId, payload),
    onSuccess: () => {
      invalidate();
      showToast.success('Correction added');
      setCorrEntry(null);
      corrForm.reset();
    },
    onError: () => showToast.error('Failed to add correction'),
  });

  // ── Proof upload (3-step: get signed URL → PUT to storage → confirm) ──
  const handleProofUpload = async () => {
    if (!proofEntry || !uploadFile) return;
    setUploading(true);
    try {
      const { upload_url, file_path } = await ledgerService.getUploadProofUrl(
        workspaceId, containerId!, proofEntry.id,
        { filename: uploadFile.name, content_type: uploadFile.type, file_size: uploadFile.size },
      );
      await fetch(upload_url, {
        method:  'PUT',
        headers: { 'Content-Type': uploadFile.type },
        body:    uploadFile,
      });
      await ledgerService.confirmProof(workspaceId, containerId!, proofEntry.id, {
        file_path,
        name:      uploadFile.name,
        size:      uploadFile.size,
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

  // ── View proof ──
  const handleViewProof = async (entry: LedgerEntry, fileIndex = 0) => {
    try {
      const { url } = await ledgerService.getProofUrl(workspaceId, containerId!, entry.id, fileIndex);
      window.open(url, '_blank');
    } catch {
      showToast.error('Could not load proof');
    }
  };

  // ── Export ──
  const handleExport = async () => {
    try {
      const csv = await ledgerService.export(workspaceId, { container_id: containerId });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      Object.assign(document.createElement('a'), {
        href:     url,
        download: `ledger-${containerId}-${Date.now()}.csv`,
      }).click();
      URL.revokeObjectURL(url);
    } catch {
      showToast.error('Export failed');
    }
  };

  // ── Open edit modal pre-filled ──
  const openEdit = (entry: LedgerEntry) => {
    editForm.reset({
      original_amount:   entry.original_amount,
      original_currency: entry.original_currency,
      note:              entry.note ?? '',
      payment_method:    entry.payment_method ?? '',
    });
    setEditEntry(entry);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Ledger</h2>
        <div className="flex items-center gap-2">
          <select
            className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white"
            value={filterStatus}
            onChange={e => setFilter(e.target.value)}
          >
            <option value="">All status</option>
            {LEDGER_STATUSES.map(s => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {isAdmin && (
            <Button size="sm" variant="secondary" onClick={handleExport}>
              <Download size={14} /> Export
            </Button>
          )}
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
      {!isLoading && entries.length === 0 && (
        <EmptyState icon={<Receipt size={36} />} title="No contributions yet" />
      )}

      <div className="space-y-3">
        {entries.map(entry => {
          const canEdit        = entry.status === 'pending';
          const canUploadProof = entry.status === 'pending' || entry.status === 'proof_uploaded';
          const hasProofs      = (entry.proofs?.length ?? 0) > 0;

          return (
            <div
              key={entry.id}
              className="bg-white border border-border rounded-xl p-4 flex items-center justify-between gap-3"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-text-primary text-sm truncate">
                  {entry.contributor_name}
                </p>
                <p className="text-xs text-text-secondary mt-0.5">
                  <CurrencyAmount amount={entry.original_amount} currency={entry.original_currency} />
                  {' · '}
                  {timeAgo(entry.recorded_at ?? entry.created_at)}
                </p>
                {entry.note && (
                  <p className="text-xs text-text-secondary mt-1 italic truncate">{entry.note}</p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge status={entry.status} />

                {/* Admin: confirm pending/proof_uploaded */}
                {isAdmin && (entry.status === 'pending' || entry.status === 'proof_uploaded') && (
                  <button
                    onClick={() => confirmMutation.mutate(entry.id)}
                    disabled={confirmMutation.isPending}
                    className="text-xs text-primary font-semibold hover:underline disabled:opacity-50"
                  >
                    Confirm
                  </button>
                )}

                {/* Edit — own pending entries (admin: any pending) */}
                {canEdit && (
                  <button
                    title="Edit entry"
                    onClick={() => openEdit(entry)}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                )}

                {/* Upload proof */}
                {canUploadProof && (
                  <button
                    title="Upload proof"
                    onClick={() => { setProofEntry(entry); setUploadFile(null); }}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Upload size={14} />
                  </button>
                )}

                {/* View proof */}
                {hasProofs && (
                  <button
                    title={`View proof${(entry.proofs!.length > 1) ? ` (${entry.proofs!.length} files)` : ''}`}
                    onClick={() => handleViewProof(entry)}
                    className="text-text-secondary hover:text-primary transition-colors"
                  >
                    <Eye size={14} />
                  </button>
                )}

                {/* Admin: add correction */}
                {isAdmin && (
                  <button
                    title="Add correction"
                    onClick={() => {
                      corrForm.reset({ original_currency: entry.original_currency });
                      setCorrEntry(entry);
                    }}
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

      <Pagination
        page={page}
        totalPages={meta?.pagination?.total_pages ?? 1}
        onPageChange={setPage}
      />

      {/* ── Add Modal ─────────────────────────────────────────────────────── */}
      <Modal
        open={showAdd}
        onClose={() => { setShowAdd(false); createForm.reset(); }}
        title="Record Contribution"
      >
        <form
          onSubmit={createForm.handleSubmit(p => {
            setPending(p);
            createMutation.mutate({ payload: p });
          })}
          className="space-y-4"
        >
          <Input
            label="Amount"
            type="number"
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
          <Input
            label="Payment method (optional)"
            placeholder="bank transfer, cash…"
            {...createForm.register('payment_method')}
          />
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
              onClick={() => { setShowAdd(false); createForm.reset(); }}
            >
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={createMutation.isPending}>Submit</Button>
          </div>
        </form>
      </Modal>

      {/* ── Duplicate Modal ───────────────────────────────────────────────── */}
      <Modal
        open={showDupe}
        onClose={() => setShowDupe(false)}
        title="Possible Duplicate"
        description="A similar contribution was recorded in the last 10 minutes. Submit anyway?"
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

      {/* ── Edit Modal ────────────────────────────────────────────────────── */}
      <Modal
        open={!!editEntry}
        onClose={() => setEditEntry(null)}
        title="Edit Entry"
      >
        <form
          onSubmit={editForm.handleSubmit(p =>
            editEntry && updateMutation.mutate({ entryId: editEntry.id, payload: p }),
          )}
          className="space-y-4"
        >
          <Input
            label="Amount"
            type="number"
            error={editForm.formState.errors.original_amount?.message}
            {...editForm.register('original_amount')}
          />
          <Input
            label="Currency"
            error={editForm.formState.errors.original_currency?.message}
            {...editForm.register('original_currency')}
          />
          <Input label="Payment method (optional)" {...editForm.register('payment_method')} />
          <Textarea label="Notes (optional)" rows={2} {...editForm.register('note')} />
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={() => setEditEntry(null)}>
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={updateMutation.isPending}>Save</Button>
          </div>
        </form>
      </Modal>

      {/* ── Upload Proof Modal ────────────────────────────────────────────── */}
      <Modal
        open={!!proofEntry}
        onClose={() => { setProofEntry(null); setUploadFile(null); }}
        title="Upload Proof"
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

      {/* ── Add Correction Modal (admin only) ─────────────────────────────── */}
      <Modal
        open={!!corrEntry}
        onClose={() => { setCorrEntry(null); corrForm.reset(); }}
        title="Add Correction"
      >
        <form
          onSubmit={corrForm.handleSubmit(p =>
            corrEntry && corrMutation.mutate({ entryId: corrEntry.id, payload: p }),
          )}
          className="space-y-4"
        >
          <p className="text-xs text-text-secondary">
            Use a negative amount to reduce the balance. The correction will be auto-confirmed.
          </p>
          <Input
            label="Correction amount"
            type="number"
            error={corrForm.formState.errors.original_amount?.message}
            {...corrForm.register('original_amount')}
          />
          <Input
            label="Currency"
            error={corrForm.formState.errors.original_currency?.message}
            {...corrForm.register('original_currency')}
          />
          <Input
            label="Base amount"
            type="number"
            error={corrForm.formState.errors.base_amount?.message}
            {...corrForm.register('base_amount')}
          />
          <Textarea
            label="Reason (required)"
            rows={2}
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
            <Button fullWidth type="submit" loading={corrMutation.isPending}>
              Apply correction
            </Button>
          </div>
        </form>
      </Modal>

    </div>
  );
}
