import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface ContentContainerProps {
  as?: ElementType;
  /**
   * `app`   — 1216px. Tables, grids, settings. The default.
   * `prose` — 704px.  Long-form reading, where measure matters more than room.
   * `full`  — no cap. For surfaces that own their own width, like a chat
   *           thread that centres its own column against a full-bleed composer.
   */
  width?: 'app' | 'prose' | 'full';
  className?: string;
  children: ReactNode;
}

/**
 * Horizontal rhythm inside the app, and the counterpart to marketing's
 * `Container`.
 *
 * Separate from `Container` rather than a variant of it because the two answer
 * to different constraints: marketing is measured against a full viewport and
 * breathes at 1088px, while the app is measured against whatever the sidebar
 * left behind and runs denser. Folding them together would mean one component
 * whose padding depends on which half of the product is calling it.
 *
 * Padding steps 16 → 24 → 32. The 16px floor is what keeps text off the bezel
 * on a 375px screen without stealing a fifth of the line.
 */
export function ContentContainer({
  as: Component = 'div',
  width = 'app',
  className,
  children,
}: ContentContainerProps) {
  return (
    <Component
      className={cn(
        'mx-auto w-full px-4 sm:px-6 lg:px-8',
        width === 'app' && 'max-w-[var(--container-app)]',
        width === 'prose' && 'max-w-[var(--container-prose)]',
        className,
      )}
    >
      {children}
    </Component>
  );
}
