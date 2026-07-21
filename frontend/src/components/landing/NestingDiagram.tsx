import { Users, CalendarHeart, Receipt } from 'lucide-react';

const LEVELS = [
  {
    icon: Users,
    label: 'Workspace',
    tag: 'The family',
    description: 'One private space per family. Members, currency, and a shared history — created once, in seconds.',
    accent: 'border-primary/30 bg-primary/[0.04]',
    iconWrap: 'bg-primary/10 text-primary',
  },
  {
    icon: CalendarHeart,
    label: 'Container',
    tag: 'What you\u2019re coordinating',
    description: 'A one-off event like a wedding or funeral, or a recurring pool like a monthly susu — with money, tasks, or both.',
    accent: 'border-accent/30 bg-accent/[0.04]',
    iconWrap: 'bg-accent/10 text-accent',
  },
  {
    icon: Receipt,
    label: 'Ledger',
    tag: 'Every contribution, tracked',
    description: 'Who paid, how much, proof of payment, admin confirmation — an honest record nobody has to take on faith.',
    accent: 'border-success/30 bg-success/[0.04]',
    iconWrap: 'bg-success/10 text-success',
  },
];

/**
 * Renders the product's real nesting structure (Workspace contains Containers,
 * Containers contain the Ledger) as concentric frames rather than a numbered
 * step sequence — order isn't the point here, containment is.
 */
export function NestingDiagram() {
  return (
    <div className="relative">
      {LEVELS.map((level, i) => {
        const Icon = level.icon;
        return (
          <div
            key={level.label}
            className={`rounded-3xl border-2 ${level.accent} transition-transform`}
            style={{ padding: `${28 - i * 4}px`, marginLeft: i === 0 ? 0 : 'auto', marginRight: i === 0 ? 0 : 'auto' }}
          >
            <div className="flex items-start gap-4">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${level.iconWrap}`}>
                <Icon size={20} strokeWidth={2.25} />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="text-lg font-extrabold text-text-primary">{level.label}</h3>
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{level.tag}</span>
                </div>
                <p className="mt-1 text-sm text-text-secondary leading-relaxed max-w-md">{level.description}</p>
              </div>
            </div>
            {i < LEVELS.length - 1 && (
              <div className="mt-6 border-t border-dashed border-border/80" />
            )}
          </div>
        );
      })}
    </div>
  );
}
