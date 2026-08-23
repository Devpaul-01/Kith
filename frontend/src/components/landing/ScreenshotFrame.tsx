import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

interface Props {
  src: string;
  alt: string;
  caption?: ReactNode;
  className?: string;
  imgClassName?: string;
  priority?: boolean;
}

/**
 * Presents a real product screenshot inside the same card language the
 * rest of the landing page already uses (rounded-3xl, border-border,
 * shadow-card-hover) — a light browser chrome makes it read as "the real
 * app" rather than a floating raster image, without adding a competing
 * visual style. Used in place of the illustrative *Preview components
 * once a genuine screenshot is available for that section.
 */
export function ScreenshotFrame({ src, alt, caption, className, imgClassName, priority = false }: Props) {
  return (
    <figure className={cn('mx-auto', className)}>
      <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-card-hover">
        {/* minimal browser chrome — grounds the image as a real, live application */}
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-page px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-200" />
        </div>
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          className={cn('block w-full h-auto', imgClassName)}
        />
      </div>
      {caption && (
        <figcaption className="mt-3 text-center text-xs font-medium text-text-secondary">{caption}</figcaption>
      )}
    </figure>
  );
}
