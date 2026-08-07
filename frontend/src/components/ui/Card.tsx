import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a hover treatment. Only for cards that are actually clickable. */
  interactive?: boolean;
}

/**
 * Flat by default. Elevation is reserved for things that genuinely float
 * (menus, dialogs); a resting card separates with a hairline and nothing else.
 */
export function Card({ className, interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-raised',
        interactive &&
          'transition-colors duration-200 ease-[var(--ease-standard)] hover:border-line-strong hover:bg-subtle',
        className,
      )}
      {...props}
    />
  );
}
