import { useEffect, useState } from 'react';
import { Check, Bell, RotateCcw } from 'lucide-react';
import { cn } from '@/utils/cn';

const MONTHS = ['June', 'July', 'August'];
const STEPS = ['collecting', 'completed', 'reminders', 'next'] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, string> = {
  collecting: 'Cycle open — collecting',
  completed: 'Cycle closed — 100% collected',
  reminders: 'Reminders sent for next cycle',
  next: 'Next cycle opens automatically',
};

/**
 * A small looping animation showing one recurring pool completing a cycle
 * and rolling into the next month with no manual recreation — communicates
 * "Kith remembers this so you don't have to" without any video asset.
 */
export function CycleAnimation() {
  const [monthIndex, setMonthIndex] = useState(0);
  const [step, setStep] = useState<Step>('collecting');

  useEffect(() => {
    const stepDurations: Record<Step, number> = { collecting: 1400, completed: 1200, reminders: 1200, next: 1400 };
    const id = setTimeout(() => {
      const idx = STEPS.indexOf(step);
      if (step === 'next') {
        setMonthIndex((m) => (m + 1) % MONTHS.length);
        setStep('collecting');
      } else {
        setStep(STEPS[idx + 1]);
      }
    }, stepDurations[step]);
    return () => clearTimeout(id);
  }, [step]);

  const pct = step === 'collecting' ? 62 : 100;

  return (
    <div className="rounded-2xl border border-border bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Parents' Monthly Healthcare Support</p>
          <p className="mt-0.5 text-lg font-extrabold text-text-primary">{MONTHS[monthIndex]} cycle</p>
        </div>
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
            step === 'completed' ? 'bg-success/10 text-success' : step === 'reminders' ? 'bg-warning/10 text-warning' : step === 'next' ? 'bg-primary/10 text-primary' : 'bg-slate-100 text-text-secondary'
          )}
        >
          {step === 'completed' && <Check size={12} />}
          {step === 'reminders' && <Bell size={12} />}
          {step === 'next' && <RotateCcw size={12} />}
          {STEP_LABEL[step]}
        </span>
      </div>

      <div className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-primary transition-all duration-[1200ms] ease-out"
          style={{ width: `${step === 'next' ? 0 : pct}%` }}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-text-secondary">
        <span>£{step === 'next' ? '0' : step === 'collecting' ? '372' : '600'} of £600</span>
        <span>Carries forward automatically if unpaid</span>
      </div>
    </div>
  );
}
