import { CheckCircle2, Circle, Clock } from 'lucide-react';
import { FamilyAvatar } from './FamilyAvatar';
import { cn } from '@/utils/cn';

const STORIES = [
  {
    name: 'Grace Adeyemi',
    task: 'Order the cake',
    detail: 'Your cousin volunteers to handle catering. Everyone immediately sees the assignment.',
    status: 'in_progress' as const,
  },
  {
    name: 'Esther Adeyemi',
    task: 'Call relatives in Lagos',
    detail: 'Your aunt agrees to call relatives. Once completed, everyone knows it\u2019s been taken care of.',
    status: 'completed' as const,
  },
  {
    name: 'Daniel Adeyemi',
    task: 'Arrange decorations',
    detail: 'Instead of being reminded repeatedly in the group chat, the task stays attached to the event until it\u2019s done.',
    status: 'pending' as const,
  },
];

const STATUS_META = {
  completed: { icon: CheckCircle2, label: 'Completed', className: 'text-success bg-success/10' },
  in_progress: { icon: Clock, label: 'In progress', className: 'text-warning bg-warning/10' },
  pending: { icon: Circle, label: 'Not started', className: 'text-text-secondary bg-slate-100' },
};

export function TaskStoryCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {STORIES.map((s) => {
        const meta = STATUS_META[s.status];
        const Icon = meta.icon;
        return (
          <div key={s.task} className="flex h-full flex-col rounded-2xl border border-border bg-white p-5 shadow-card">
            <div className="flex items-center gap-2.5">
              <FamilyAvatar name={s.name} size="sm" />
              <p className="text-sm font-semibold text-text-primary">{s.name}</p>
            </div>
            <p className="mt-3 text-base font-bold text-text-primary">{s.task}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-text-secondary flex-1">{s.detail}</p>
            <span className={cn('mt-4 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold', meta.className)}>
              <Icon size={12} />
              {meta.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
