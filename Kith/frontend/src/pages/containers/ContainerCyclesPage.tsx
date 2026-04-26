import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { participantService } from '@/services/participant.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Button } from '@/components/ui/Button';
import { formatDate } from '@/utils/date';
import { formatCurrency } from '@/utils/currency';
import { Settings } from 'lucide-react';
import type { Cycle } from '@/types/models';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { CycleOverrideModal } from '@/components/cycles/CycleOverrideModal';

export default function ContainerCyclesPage() {
  const { id: containerId } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const isAdmin  = useIsAdmin();
  const workspace = useWorkspaceStore(s => s.workspace);
  const [selectedCycle, setSelectedCycle]   = useState<Cycle | null>(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  const { data: cyclesData, isLoading: cyclesLoading } = useQuery({
    queryKey: KEYS.cycles(workspaceId, containerId!),
    queryFn:  () => containerService.listCycles(workspaceId, containerId!),
  });

  const { data: participantsData } = useQuery({
    queryKey: KEYS.participants(workspaceId, containerId!),
    queryFn:  () => participantService.list(workspaceId, containerId!),
    enabled:  isAdmin,
  });

  const cycles: Cycle[] = (cyclesData as { cycles?: Cycle[] })?.cycles ?? [];
  const participants     = (participantsData as { participants?: any[] })?.participants ?? [];
  const participantOptions = participants.map(p => ({
    id:           p.workspace_member_id,
    display_name: p.display_name,
  }));

  const currency = workspace?.base_currency ?? 'USD';

  const handleOverrideClick = (cycle: Cycle) => {
    setSelectedCycle(cycle);
    setShowOverrideModal(true);
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text-primary">Cycles</h2>
        {isAdmin && (
          <p className="text-xs text-text-secondary">
            Cycles are auto-generated for recurring containers
          </p>
        )}
      </div>

      {cyclesLoading && <div className="flex justify-center py-8"><Spinner /></div>}

      {!cyclesLoading && cycles.length === 0 && (
        <div className="text-center py-8 text-text-secondary">
          No cycles available for this container.
        </div>
      )}

      <div className="space-y-3">
        {cycles.map(c => (
          <div key={c.id} className="bg-white border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <p className="font-medium text-text-primary">Cycle {c.cycle_number}</p>
                <Badge status={c.status} />
              </div>
              {/* FIX: backend override allows 'open' or 'upcoming' cycles */}
              {isAdmin && (c.status === 'open' || c.status === 'upcoming') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleOverrideClick(c)}
                  className="text-text-secondary hover:text-primary"
                >
                  <Settings size={14} /> Override
                </Button>
              )}
            </div>
            {/* FIX: use cycle_start / cycle_end (DB column names, not start_date / end_date) */}
            <div className="text-xs text-text-secondary flex gap-4">
              <span>Start: {formatDate(c.cycle_start)}</span>
              <span>End: {formatDate(c.cycle_end)}</span>
            </div>
            <ProgressBar
              value={c.total_collected}
              max={c.total_expected || 100}
            />
            <div className="flex justify-between text-xs text-text-secondary">
              <span>{formatCurrency(c.total_collected, currency)} collected</span>
              <span>of {formatCurrency(c.total_expected, currency)}</span>
            </div>
          </div>
        ))}
      </div>

      {selectedCycle && (
        <CycleOverrideModal
          open={showOverrideModal}
          onClose={() => {
            setShowOverrideModal(false);
            setSelectedCycle(null);
          }}
          workspaceId={workspaceId}
          containerId={containerId!}
          cycleId={selectedCycle.id}
          cycleNumber={selectedCycle.cycle_number}
          participants={participantOptions}
          currency={currency}
        />
      )}
    </div>
  );
}
