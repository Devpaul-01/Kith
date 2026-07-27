import { useEffect, useState } from 'react';
import { Bell, CheckCircle2, Clock, TrendingUp } from 'lucide-react';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { FamilyAvatar } from './FamilyAvatar';
import { cn } from '@/utils/cn';
import { DEMO_DASHBOARD, DEMO_CONTAINERS } from '@/constants/demoFamily';

const CALLOUTS = [
  { key: 'events', label: 'Upcoming event' },
  { key: 'contributions', label: 'Contribution progress' },
  { key: 'activity', label: 'Recent activity' },
  { key: 'tasks', label: 'Pending tasks' },
] as const;

/**
 * A genuinely live, data-driven rendering of the family dashboard — built
 * from the same shapes as DashboardData in models.ts rather than a static
 * image. Intended as a drop-in placeholder: swap for a real product
 * screenshot later without changing any surrounding layout, since this
 * renders at the same aspect ratio a 1440x900 capture would.
 */
export function DashboardPreview({ annotated = false }: { annotated?: boolean }) {
  const [activeCallout, setActiveCallout] = useState(0);

  useEffect(() => {
    if (!annotated) return;
    const id = setInterval(() => setActiveCallout((i) => (i + 1) % CALLOUTS.length), 2600);
    return () => clearInterval(id);
  }, [annotated]);

  const events = DEMO_CONTAINERS.filter((c) => c.container_type === 'event');
  const pools = DEMO_CONTAINERS.filter((c) => c.container_type === 'recurring');

  return (
    <div className="relative rounded-3xl border border-border bg-white shadow-card-hover overflow-hidden">
      {/* top bar */}
      <div className="flex items-center justify-between border-b border-border bg-surface-page px-5 py-3.5 sm:px-7">
        <div>
          <p className="text-sm font-bold text-text-primary">The Adeyemi Family</p>
          <p className="text-xs text-text-secondary">7 members · GBP</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bell size={16} className="text-text-secondary" />
            <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-white">
              {DEMO_DASHBOARD.unread_notification_count}
            </span>
          </div>
          <div className="flex -space-x-2">
            {['David Adeyemi', 'Sarah Adeyemi', 'Grace Adeyemi'].map((n) => (
              <FamilyAvatar key={n} name={n} size="sm" className="ring-2 ring-white" />
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 p-5 sm:p-7 lg:grid-cols-3">
        {/* upcoming event */}
        <div
          className={cn(
            'lg:col-span-2 rounded-2xl border p-4 transition-all',
            annotated && activeCallout === 0 ? 'border-primary shadow-card-hover' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-text-secondary">Upcoming event</p>
            {annotated && activeCallout === 0 && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-white">Upcoming Event</span>
            )}
          </div>
          <p className="mt-1.5 text-lg font-extrabold text-text-primary">{events[0].name}</p>
          <p className="text-xs text-text-secondary">{events[0].subtitle}</p>
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-text-secondary">Raised</span>
              <span className="font-bold text-text-primary">
                <CurrencyAmount amount={events[0].total_confirmed!} currency="GBP" /> of{' '}
                <CurrencyAmount amount={events[0].total_expected!} currency="GBP" />
              </span>
            </div>
            <ProgressBar value={events[0].total_confirmed!} max={events[0].total_expected!} className="mt-1" />
          </div>
        </div>

        {/* pending tasks */}
        <div
          className={cn(
            'rounded-2xl border p-4 transition-all',
            annotated && activeCallout === 3 ? 'border-accent shadow-card-hover' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-text-secondary">Pending tasks</p>
            {annotated && activeCallout === 3 && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-white">Pending Tasks</span>
            )}
          </div>
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <Clock size={12} className="text-warning shrink-0" />
              <span className="text-text-primary">Order the cake — Grace</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <Clock size={12} className="text-warning shrink-0" />
              <span className="text-text-primary">Decorations — Daniel</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <CheckCircle2 size={12} className="text-success shrink-0" />
              <span className="text-text-secondary line-through">Book the hall</span>
            </div>
          </div>
        </div>

        {/* recurring pools */}
        <div
          className={cn(
            'rounded-2xl border p-4 transition-all',
            annotated && activeCallout === 1 ? 'border-primary shadow-card-hover' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-text-secondary">Contribution progress</p>
            {annotated && activeCallout === 1 && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-white">Progress</span>
            )}
          </div>
          <div className="mt-2 space-y-3">
            {pools.map((p) => (
              <div key={p.id}>
                <p className="text-xs font-medium text-text-primary truncate">{p.name}</p>
                <ProgressBar value={p.total_confirmed!} max={p.total_expected!} className="mt-1" color={p.progress_pct === 100 ? 'bg-success' : 'bg-primary'} />
              </div>
            ))}
          </div>
        </div>

        {/* recent activity */}
        <div
          className={cn(
            'lg:col-span-2 rounded-2xl border p-4 transition-all',
            annotated && activeCallout === 2 ? 'border-success shadow-card-hover' : 'border-border'
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wide text-text-secondary">Recent activity</p>
            {annotated && activeCallout === 2 && (
              <span className="rounded-full bg-success px-2 py-0.5 text-[10px] font-bold text-white">Recent Activity</span>
            )}
          </div>
          <div className="mt-2 space-y-2.5">
            {DEMO_DASHBOARD.recent_activity!.slice(0, 3).map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs">
                <TrendingUp size={12} className="text-text-secondary shrink-0" />
                <span className="text-text-primary truncate">{a.description}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
