import { cn } from '@/utils/cn';

// Consistent initials + color per family member, reused across every
// section so the same seven people are visually recognizable throughout
// the page — this is the page's storytelling anchor.
const MEMBER_STYLE: Record<string, { initials: string; className: string }> = {
  'David Adeyemi': { initials: 'DA', className: 'bg-primary/10 text-primary' },
  'Sarah Adeyemi': { initials: 'SA', className: 'bg-accent/10 text-accent' },
  'Michael Adeyemi': { initials: 'MA', className: 'bg-success/10 text-success' },
  'Esther Adeyemi': { initials: 'EA', className: 'bg-orange-100 text-orange-700' },
  'Grace Adeyemi': { initials: 'GA', className: 'bg-pink-100 text-pink-700' },
  'Daniel Adeyemi': { initials: 'DA2', className: 'bg-blue-100 text-blue-700' },
  'Grandma Ruth': { initials: 'GR', className: 'bg-purple-100 text-purple-700' },
};

interface Props {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  isProxy?: boolean;
  className?: string;
}

const SIZES = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-11 w-11 text-sm',
};

export function FamilyAvatar({ name, size = 'md', isProxy, className }: Props) {
  const style = MEMBER_STYLE[name] ?? { initials: name.slice(0, 2).toUpperCase(), className: 'bg-slate-100 text-slate-600' };
  return (
    <div className="relative shrink-0">
      <div
        className={cn(
          'flex items-center justify-center rounded-full font-bold',
          SIZES[size],
          style.className,
          className
        )}
        title={name}
      >
        {style.initials.replace('2', '')}
      </div>
      {isProxy && (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-text-secondary shadow-card ring-1 ring-border"
          title="Represented by a trusted family member"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-text-secondary" />
        </span>
      )}
    </div>
  );
}
