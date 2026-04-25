import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { participantService } from '@/services/participant.service';
import { KEYS } from '@/constants/queryKeys';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import showToast from '@/lib/toast';
import type { Participant, CycleTargetEntry } from '@/types/models';
import { X, ChevronDown, ChevronUp } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  participant: Participant;
  workspaceId: string;
  containerId: string;
}

type OverrideType = 'skip_member' | 'adjust_target';

interface OverrideState {
  cycleId: string;
  type: OverrideType;
  newTarget: string;
  newCurrency: string;
  reason: string;
}

const STATUS_STYLES: Record<string, string> = {
  paid:    'bg-green-100 text-green-700',
  partial: 'bg-amber-100 text-amber-700',
  pending: 'bg-gray-100 text-gray-600',
  overdue: 'bg-red-100 text-red-700',
  skipped: 'bg-gray-100 text-gray-400',
};

export function CycleTargetsModal({ open, onClose, participant, workspaceId, containerId }: Props) {
  const qc = useQueryClient();

  const [override, setOverride] = useState<OverrideState | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: KEYS.cycleTargets(workspaceId, containerId, participant.id),
    queryFn: () => participantService.getCycleTargets(workspaceId, containerId, participant.id),
    enabled: open,
  });

  const cycleTargets: CycleTargetEntry[] = (data as { cycle_targets?: CycleTargetEntry[] })?.cycle_targets ?? [];

  const overrideMutation = useMutation({
    mutationFn: (vars: { cycleId: string; payload: Parameters<typeof participantService.overrideCycle>[3] }) =>
      participantService.overrideCycle(workspaceId, containerId, vars.cycleId, vars.payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.cycleTargets(workspaceId, containerId, participant.id) });
      showToast.success('Override applied');
      setOverride(null);
    },
    onError: (error: any) => {
      const msg = error?.response?.data?.error?.message || 'Failed to apply override';
      showToast.error(msg);
    },
  });

  const handleOverrideSubmit = () => {
    if (!override) return;

    if (override.type === 'skip_member') {
      overrideMutation.mutate({
        cycleId: override.cycleId,
        payload: {
          override_type: 'skip_member',
          member_id: participant.workspace_member_id,
          reason: override.reason || undefined,
        },
      });
    }

    if (override.type === 'adjust_target') {
      if (!override.newTarget) {
        showToast.error('Please enter a new target amount');
        return;
      }
      overrideMutation.mutate({
        cycleId: override.cycleId,
        payload: {
          override_type: 'adjust_target',
          member_id: participant.workspace_member_id,
          new_target: parseFloat(override.newTarget),
          new_currency: override.newCurrency || undefined,
          reason: override.reason || undefined,
        },
      });
    }
  };

  const openOverride = (cycleId: string, type: OverrideType, defaultCurrency: string) => {
    // Toggle off if already open for same cycle+type
    if (override?.cycleId === cycleId && override?.type === type) {
      setOverride(null);
      return;
    }
    setOverride({ cycleId, type, newTarget: '', newCurrency: defaultCurrency, reason: '' });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div>
            <h3 className="font-semibold text-text-primary">Cycle Targets</h3>
            <p className="text-xs text-text-secondary">{participant.display_name}</p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary p-1">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1">
          {isLoading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}

          {!isLoading && cycleTargets.length === 0 && (
            <div className="text-center py-8 text-sm text-text-secondary">
              No cycles found for this container.
            </div>
          )}

          {!isLoading && cycleTargets.length > 0 && (
            <div className="divide-y divide-border">
              {cycleTargets.map(entry => {
                const canOverride = ['upcoming', 'open'].includes(entry.cycle.status);
                const isSkipOpen = override?.cycleId === entry.cycle.id && override?.type === 'skip_member';
                const isAdjustOpen = override?.cycleId === entry.cycle.id && override?.type === 'adjust_target';

                return (
                  <div key={entry.cycle.id} className="p-4 space-y-3">
                    {/* Cycle row */}
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          Cycle {entry.cycle.cycle_number}
                        </p>
                        <p className="text-xs text-text-secondary">
                          {new Date(entry.cycle.cycle_start).toLocaleDateString()} –{' '}
                          {new Date(entry.cycle.cycle_end).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[entry.status] ?? 'bg-gray-100 text-gray-600'}`}>
                          {entry.status}
                        </span>
                      </div>
                    </div>

                    {/* Target + paid summary */}
                    <div className="flex gap-4 text-xs text-text-secondary">
                      {entry.target ? (
                        <span>
                          Target: <span className="text-text-primary font-medium">
                            <CurrencyAmount amount={entry.target.amount} currency={entry.target.currency} />
                          </span>
                        </span>
                      ) : (
                        <span>No target set</span>
                      )}
                      {entry.confirmed_paid_base > 0 && (
                        <span>
                          Paid: <span className="text-text-primary font-medium">
                            {entry.confirmed_paid_base.toFixed(2)}
                          </span>
                        </span>
                      )}
                    </div>

                    {/* Override actions — only for upcoming or open cycles */}
                    {canOverride && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => openOverride(entry.cycle.id, 'skip_member', entry.target?.currency || 'USD')}
                          className="flex items-center gap-1 text-xs text-text-secondary border border-border rounded-lg px-2.5 py-1 hover:bg-surface"
                        >
                          Skip this cycle
                          {isSkipOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                        <button
                          onClick={() => openOverride(entry.cycle.id, 'adjust_target', entry.target?.currency || 'USD')}
                          className="flex items-center gap-1 text-xs text-text-secondary border border-border rounded-lg px-2.5 py-1 hover:bg-surface"
                        >
                          Adjust target
                          {isAdjustOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      </div>
                    )}

                    {/* Inline override form */}
                    {(isSkipOpen || isAdjustOpen) && override && (
                      <div className="bg-surface rounded-xl p-3 space-y-3 border border-border">
                        <p className="text-xs font-semibold text-text-primary">
                          {isSkipOpen ? 'Skip member for this cycle' : 'Adjust target for this cycle'}
                        </p>

                        {isAdjustOpen && (
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <label className="block text-xs text-text-secondary mb-1">New Amount</label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={override.newTarget}
                                onChange={e => setOverride(o => o ? { ...o, newTarget: e.target.value } : o)}
                                placeholder="0.00"
                                className="w-full border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary bg-white"
                              />
                            </div>
                            <div className="w-20">
                              <label className="block text-xs text-text-secondary mb-1">Currency</label>
                              <input
                                type="text"
                                value={override.newCurrency}
                                onChange={e => setOverride(o => o ? { ...o, newCurrency: e.target.value.toUpperCase() } : o)}
                                maxLength={3}
                                className="w-full border border-border rounded-lg px-3 py-1.5 text-sm uppercase outline-none focus:ring-1 focus:ring-primary bg-white"
                              />
                            </div>
                          </div>
                        )}

                        <div>
                          <label className="block text-xs text-text-secondary mb-1">Reason (optional)</label>
                          <input
                            type="text"
                            value={override.reason}
                            onChange={e => setOverride(o => o ? { ...o, reason: e.target.value } : o)}
                            placeholder="Reason for override…"
                            className="w-full border border-border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary bg-white"
                          />
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => setOverride(null)}
                            className="flex-1 border border-border rounded-lg py-1.5 text-xs text-text-secondary hover:bg-white"
                          >
                            Cancel
                          </button>
                          <Button
                            size="sm"
                            onClick={handleOverrideSubmit}
                            disabled={overrideMutation.isPending}
                            className="flex-1 text-xs"
                          >
                            {overrideMutation.isPending ? <Spinner /> : 'Confirm'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="w-full border border-border rounded-lg py-2 text-sm text-text-secondary hover:bg-surface"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
