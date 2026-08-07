import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface ContainerProps {
  as?: ElementType;
  /** `content` = marketing measure (1088px). `prose` = reading measure (704px). */
  width?: 'content' | 'prose';
  className?: string | undefined;
  children: ReactNode;
}

/**
 * The single horizontal-rhythm authority. Every section uses it, so the left
 * edge of every heading on the site lands on exactly the same pixel — the
 * cheapest and most visible source of "this was designed".
 */
export function Container({
  as: Component = 'div',
  width = 'content',
  className,
  children,
}: ContainerProps) {
  return (
    <Component
      className={cn(
        'mx-auto w-full px-6 sm:px-8',
        width === 'content' ? 'max-w-[var(--container-content)]' : 'max-w-[var(--container-prose)]',
        className,
      )}
    >
      {children}
    </Component>
  );
}
