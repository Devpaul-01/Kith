import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { participantService } from '@/services/participant.service';
import { KEYS } from '@/constants/queryKeys';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import showToast from '@/lib/toast';
import type { Participant } from '@/types/models';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  participant: Participant;
  workspaceId: string;
  containerId: string;
  enableMoney: boolean;
  enableTasks: boolean;
}

export function EditParticipantModal({
  open,
  onClose,
  participant,
  workspaceId,
  containerId,
  enableMoney,
  enableTasks,
}: Props) {
  const qc = useQueryClient();

  const [form, setForm] = useState({
    money_enabled: participant.money_enabled,
    tasks_enabled: participant.tasks_enabled,
    role: participant.role || '',
    notes: participant.notes || '',
    exclude_from_public: participant.exclude_from_public ?? false,
  });

  const [target, setTarget] = useState({
    amount: participant.target_amount ? String(participant.target_amount) : '',
    currency: participant.target_currency || 'USD',
    due_date: participant.due_date || '',
  });

  const [targetChanged, setTargetChanged] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      participantService.update(workspaceId, containerId, participant.id, data),
    onError: (error: any) => {
      const msg = error?.response?.data?.error?.message || 'Failed to update participant';
      showToast.error(msg);
    },
  });

  const targetMutation = useMutation({
    mutationFn: (data: { amount: number; currency: string; due_date?: string }) =>
      participantService.setTarget(workspaceId, containerId, participant.id, data),
    onError: (error: any) => {
      const msg = error?.response?.data?.error?.message || 'Failed to set target';
      showToast.error(msg);
    },
  });

  const handleSave = async () => {
    // Build only the fields that actually changed
    const updates: Record<string, unknown> = {};
    if (form.money_enabled !== participant.money_enabled) updates.money_enabled = form.money_enabled;
    if (form.tasks_enabled !== participant.tasks_enabled) updates.tasks_enabled = form.tasks_enabled;
    if (form.role !== (participant.role || '')) updates.role = form.role || null;
    if (form.notes !== (participant.notes || '')) updates.notes = form.notes || null;
    if (form.exclude_from_public !== (participant.exclude_from_public ?? false)) {
      updates.exclude_from_public = form.exclude_from_public;
    }

    try {
      if (Object.keys(updates).length > 0) {
        await updateMutation.mutateAsync(updates);
      }

      if (targetChanged && enableMoney && form.money_enabled && target.amount) {
        await targetMutation.mutateAsync({
          amount: parseFloat(target.amount),
          currency: target.currency,
          due_date: target.due_date || undefined,
        });
      }

      qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, containerId) });
      showToast.success('Participant updated');
      onClose();
    } catch {
      // individual errors handled in onError above
    }
  };

  if (!open) return null;

  const isPending = updateMutation.isPending || targetMutation.isPending;
  const showTarget = enableMoney && form.money_enabled;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div>
            <h3 className="font-semibold text-text-primary">Edit Participant</h3>
            <p className="text-xs text-text-secondary">{participant.display_name}</p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary p-1">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto">

          {/* Toggles */}
          <div className="space-y-3">
            {enableMoney && (
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm text-text-primary">Money tracking</p>
                  <p className="text-xs text-text-secondary">Include in ledger and targets</p>
                </div>
                <input
                  type="checkbox"
                  checked={form.money_enabled}
                  onChange={e => setForm(f => ({ ...f, money_enabled: e.target.checked }))}
                  className="w-4 h-4 accent-primary"
                />
              </label>
            )}

            {enableTasks && (
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <p className="text-sm text-text-primary">Tasks</p>
                  <p className="text-xs text-text-secondary">Can be assigned tasks</p>
                </div>
                <input
                  type="checkbox"
                  checked={form.tasks_enabled}
                  onChange={e => setForm(f => ({ ...f, tasks_enabled: e.target.checked }))}
                  className="w-4 h-4 accent-primary"
                />
              </label>
            )}

            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="text-sm text-text-primary">Exclude from public view</p>
                <p className="text-xs text-text-secondary">Hide on the shareable link</p>
              </div>
              <input
                type="checkbox"
                checked={form.exclude_from_public}
                onChange={e => setForm(f => ({ ...f, exclude_from_public: e.target.checked }))}
                className="w-4 h-4 accent-primary"
              />
            </label>
          </div>

          <div className="border-t border-border" />

          {/* Role */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">Role</label>
            <input
              type="text"
              value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
              placeholder="e.g. Organiser"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="Internal notes about this participant…"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Target section — only when money is enabled for this participant */}
          {showTarget && (
            <>
              <div className="border-t border-border" />
              <div className="space-y-3">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  Contribution Target
                </p>
                {participant.target_amount && !targetChanged && (
                  <p className="text-xs text-text-secondary">
                    Current: {participant.target_amount} {participant.target_currency}
                    {participant.due_date && ` · Due ${new Date(participant.due_date).toLocaleDateString()}`}
                  </p>
                )}
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-text-secondary mb-1">Amount</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={target.amount}
                      onChange={e => { setTarget(t => ({ ...t, amount: e.target.value })); setTargetChanged(true); }}
                      placeholder="0.00"
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="w-24">
                    <label className="block text-xs text-text-secondary mb-1">Currency</label>
                    <input
                      type="text"
                      value={target.currency}
                      onChange={e => { setTarget(t => ({ ...t, currency: e.target.value.toUpperCase() })); setTargetChanged(true); }}
                      maxLength={3}
                      className="w-full border border-border rounded-lg px-3 py-2 text-sm uppercase outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-text-secondary mb-1">Due Date</label>
                  <input
                    type="date"
                    value={target.due_date}
                    onChange={e => { setTarget(t => ({ ...t, due_date: e.target.value })); setTargetChanged(true); }}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                {targetChanged && (
                  <p className="text-xs text-amber-600">
                    Saving will supersede the current target and record a new one.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 p-4 border-t border-border shrink-0">
          <button
            onClick={onClose}
            disabled={isPending}
            className="flex-1 border border-border rounded-lg py-2 text-sm text-text-secondary hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <Button size="sm" onClick={handleSave} disabled={isPending} className="flex-1">
            {isPending ? <Spinner /> : 'Save changes'}
          </Button>
        </div>
      </div>
    </div>
  );
}
