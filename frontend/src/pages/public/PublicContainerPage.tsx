import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicService } from '@/services/public.service';
import { KEYS } from '@/constants/queryKeys';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Spinner } from '@/components/ui/Spinner';
import { formatCurrency } from '@/utils/currency';
import { formatDate } from '@/utils/date';

interface PublicContainer {
  name: string;
  subtitle?: string;
  event_date?: string;
  budget_target?: number;
  total_confirmed_base?: number;
  progress_pct?: number;
  currency?: string;
  cover_photo_url?: string;
}

export default function PublicContainerPage() {
  const { publicToken } = useParams<{ publicToken: string }>();
  const { data, isLoading } = useQuery({
    queryKey: KEYS.publicContainer(publicToken!),
    queryFn: () => publicService.getPublicContainer(publicToken!),
    staleTime: 120_000,
  });

  const c = data as PublicContainer | undefined;

  if (isLoading) return (
    <div className="flex justify-center py-16">
      <Spinner size="lg" />
    </div>
  );

  if (!c) return (
    <div className="text-center py-16 text-text-secondary">
      This link is invalid or the event is no longer available.
    </div>
  );

  return (
    <div className="bg-white rounded-2xl border border-border p-8 mt-8 space-y-5">
      {c.cover_photo_url && (
        <img src={c.cover_photo_url} className="w-full h-48 object-cover rounded-xl" alt="" />
      )}
      <h1 className="text-2xl font-bold text-text-primary">{c.name}</h1>
      {c.subtitle && (
        <p className="text-text-secondary">{c.subtitle}</p>
      )}
      {c.event_date && (
        <p className="text-sm text-text-secondary">📅 {formatDate(c.event_date)}</p>
      )}
      {c.budget_target && (
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Collected</span>
            <span className="font-bold text-text-primary">
              {formatCurrency(c.total_confirmed_base ?? 0, c.currency ?? 'USD')}
              {' '}
              <span className="font-normal text-text-secondary">
                of {formatCurrency(c.budget_target, c.currency ?? 'USD')}
              </span>
            </span>
          </div>
          <ProgressBar value={c.progress_pct ?? 0} showLabel />
        </div>
      )}
    </div>
  );
}