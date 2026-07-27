import { cn } from '@/utils/cn';

// Encodes which of the three pillars (money / responsibility / trust) a
// section belongs to via color, so a scanning visitor can feel the page's
// structure even without reading every headline.
const PILLAR_COLOR = {
  money: 'text-primary',
  responsibility: 'text-accent',
  trust: 'text-success',
  neutral: 'text-text-secondary',
} as const;

interface Props {
  children: React.ReactNode;
  pillar?: keyof typeof PILLAR_COLOR;
  className?: string;
}

export function SectionEyebrow({ children, pillar = 'neutral', className }: Props) {
  return (
    <span className={cn('text-xs font-bold uppercase tracking-widest', PILLAR_COLOR[pillar], className)}>
      {children}
    </span>
  );
}
