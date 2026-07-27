import { CheckCircle2, PartyPopper, UserPlus, RotateCcw, Trophy, Receipt } from 'lucide-react';
import { DEMO_ACTIVITY } from '@/constants/demoFamily';
import { cn } from '@/utils/cn';

const ICON_FOR_ACTION: Record<string, { icon: typeof CheckCircle2; className: string }> = {
  contribution_confirmed: { icon: Receipt, className: 'bg-primary/10 text-primary' },
  task_completed: { icon: CheckCircle2, className: 'bg-success/10 text-success' },
  member_joined: { icon: UserPlus, className: 'bg-accent/10 text-accent' },
  cycle_closed: { icon: RotateCcw, className: 'bg-slate-100 text-text-secondary' },
  milestone_reached: { icon: Trophy, className: 'bg-warning/10 text-warning' },
  event_completed: { icon: PartyPopper, className: 'bg-pink-100 text-pink-700' },
};

function formatRelative(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A vertical timeline of family activity — used both in the "Shared
 * History" section and, in condensed form, inside the trust section.
 */
export function ActivityTimeline({ compact = false }: { compact?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-card sm:p-6">
      <ol className="relative space-y-5 before:absolute before:left-[15px] before:top-1 before:bottom-1 before:w-px before:bg-border">
        {DEMO_ACTIVITY.slice(0, compact ? 3 : 6).map((entry) => {
          const meta = ICON_FOR_ACTION[entry.action!] ?? { icon: CheckCircle2, className: 'bg-slate-100 text-text-secondary' };
          const Icon = meta.icon;
          return (
            <li key={entry.id} className="relative flex items-start gap-3 pl-0">
              <div className={cn('relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', meta.className)}>
                <Icon size={14} strokeWidth={2.25} />
              </div>
              <div className="min-w-0 pt-1">
                <p className="text-sm font-medium text-text-primary">{entry.description}</p>
                <p className="text-xs text-text-secondary">{formatRelative(entry.created_at!)}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
