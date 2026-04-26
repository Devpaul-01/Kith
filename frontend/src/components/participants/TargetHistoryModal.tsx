import { useQuery } from '@tanstack/react-query';
import { participantService } from '@/services/participant.service';
import { KEYS } from '@/constants/queryKeys';
import { Spinner } from '@/components/ui/Spinner';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import type { Participant, ContributorTarget } from '@/types/models';
import { X, CheckCircle } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  participant: Participant;
  workspaceId: string;
  containerId: string;
}

export function TargetHistoryModal({ open, onClose, participant, workspaceId, containerId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: KEYS.targetHistory(workspaceId, containerId, participant.id),
    queryFn: () => participantService.getTargetHistory(workspaceId, containerId, participant.id),
    enabled: open,
  });

  const history: ContributorTarget[] = (data as { history?: ContributorTarget[] })?.history ?? [];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div>
            <h3 className="font-semibold text-text-primary">Target History</h3>
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

          {!isLoading && history.length === 0 && (
            <div className="text-center py-8 text-sm text-text-secondary">
              No targets have been set yet.
            </div>
          )}

          {!isLoading && history.length > 0 && (
            <div className="divide-y divide-border">
              {history.map(t => (
                <div key={t.id} className="p-4 flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-text-primary">
                        <CurrencyAmount amount={t.target_amount} currency={t.target_currency} />
                      </span>
                      {t.is_current && !t.cycle_id && (
                        <span className="flex items-center gap-0.5 text-xs text-green-600 font-medium">
                          <CheckCircle size={12} /> Current
                        </span>
                      )}
                      {t.cycle_id && (
                        <span className="text-xs text-text-secondary bg-surface px-1.5 py-0.5 rounded">
                          Cycle target
                        </span>
                      )}
                    </div>
                    {t.due_date && (
                      <p className="text-xs text-text-secondary">
                        Due {new Date(t.due_date).toLocaleDateString()}
                      </p>
                    )}
                    <p className="text-xs text-text-secondary">
                      Set by {t.set_by_name || 'Admin'} · {new Date(t.set_at).toLocaleDateString()}
                    </p>
                    {t.superseded_at && (
                      <p className="text-xs text-text-secondary">
                        Superseded {new Date(t.superseded_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </div>
              ))}
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
