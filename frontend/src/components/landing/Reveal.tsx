import { cn } from '@/utils/cn';
import { useScrollReveal } from '@/hooks/useScrollReveal';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'span';
}

/** Fades + rises an element into place once, the first time it's scrolled into view. */
export function Reveal({ children, delay = 0, className, as = 'div' }: Props) {
  const { ref, visible } = useScrollReveal();
  const Tag = as as any;
  return (
    <Tag
      ref={ref}
      className={cn(
        'transition-all duration-700 ease-out',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4',
        className
      )}
      style={{ transitionDelay: visible ? `${delay}ms` : '0ms' }}
    >
      {children}
    </Tag>
  );
}
