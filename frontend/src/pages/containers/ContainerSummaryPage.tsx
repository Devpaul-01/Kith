import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Spinner } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';

/**
 * Actual shape returned by GET /containers/:id/summary (container_controller.js → getSummary)
 * Field names use the _base suffix — NOT the ContainerSummary model which has different names.
 */
interface SummaryApiResponse {
  container: { budget_currency?: string; [key: string]: any };
  total_expected_base: number;
  total_confirmed_base: number;
  total_pending_base: number;
  progress_pct: number | null;
  participants: Array<{ status: string; [key: string]: any }>;
}

export default function ContainerSummaryPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();

  const { data, isLoading } = useQuery({
    queryKey: KEYS.summary(workspaceId, id!),
    queryFn: () => containerService.getSummary(workspaceId, id!),
  });

  // Cast directly to the real API shape — no need for a "summary" wrapper key.
  const raw = data as SummaryApiResponse | undefined;

  if (isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!raw) return <div className="p-6 text-center text-text-secondary">No summary available.</div>;

  // ── Derive all values from the real response fields ──────────────────
  const currency        = raw.container?.budget_currency ?? 'USD';
  const participants    = raw.participants ?? [];
  const participantCount = participants.length;
  const confirmedCount  = participants.filter(p => p.status === 'paid').length;
  const pendingCount    = participants.filter(p =>
    ['pending', 'partial', 'overdue'].includes(p.status)
  ).length;

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h2 className="text-lg font-bold text-text-primary">Summary</h2>

      <Card className="space-y-4">
        {/* ── Money grid ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-text-secondary">Collected</p>
            <p className="text-lg font-bold text-text-primary">
              {raw.total_confirmed_base != null ? (
                <CurrencyAmount amount={raw.total_confirmed_base} currency={currency} />
              ) : (
                <span className="text-text-secondary text-base font-normal">Not available</span>
              )}
            </p>
          </div>

          <div>
            <p className="text-xs text-text-secondary">Expected</p>
            <p className="text-lg font-bold text-text-primary">
              {raw.total_expected_base != null ? (
                <CurrencyAmount amount={raw.total_expected_base} currency={currency} />
              ) : (
                <span className="text-text-secondary text-base font-normal">Not available</span>
              )}
            </p>
          </div>

          <div>
            <p className="text-xs text-text-secondary">Pending</p>
            <p className="text-lg font-bold text-text-primary">
              {raw.total_pending_base != null ? (
                <CurrencyAmount amount={raw.total_pending_base} currency={currency} />
              ) : (
                <span className="text-text-secondary text-base font-normal">Not available</span>
              )}
            </p>
          </div>

          {/* participant_count is now derived from participants.length — no more "Not available" */}
          <div>
            <p className="text-xs text-text-secondary">Participants</p>
            <p className="text-lg font-bold text-text-primary">{participantCount}</p>
          </div>
        </div>

        {/* ── Progress bar ─────────────────────────────────────────────── */}
        <div>
          {raw.progress_pct != null ? (
            <ProgressBar value={raw.progress_pct} showLabel />
          ) : (
            <p className="text-sm text-text-secondary text-center">Progress data not available</p>
          )}
        </div>

        {/* ── Status breakdown ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-green-50 rounded-lg p-2 text-center">
            <p className="text-green-700 font-semibold text-sm">{confirmedCount}</p>
            <p className="text-green-600">Confirmed</p>
          </div>
          <div className="bg-yellow-50 rounded-lg p-2 text-center">
            <p className="text-yellow-700 font-semibold text-sm">{pendingCount}</p>
            <p className="text-yellow-600">Pending</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
