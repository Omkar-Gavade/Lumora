import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Right-aligned controls — the page's primary action lives here. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The page's own heading, and the only `<h1>` on the screen.
 *
 * This is where the title belongs — not in the 56px chrome bar. At this size,
 * on the content column, set in the serif that carries the brand, it reads as
 * the start of a document. The same words squeezed into the header would read
 * as a label on a toolbar.
 *
 * Stacks below `sm`. Actions on a phone go under the title at full width
 * rather than beside it, because a button competing with a heading for a
 * 343px line loses either its label or the title's.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-h2 text-balance">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-body-sm text-secondary text-pretty">{description}</p>
        )}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
