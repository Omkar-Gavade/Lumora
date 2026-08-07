import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /**
   * `h2` by default, sitting under the page's `PageHeader`. Pass `h1` when the
   * empty state *is* the page — a screen whose only heading is an `h2` leaves
   * a screen-reader user with a document that starts at level two.
   */
  titleAs?: 'h1' | 'h2';
  className?: string;
}

/**
 * The state a page is in before anything has happened to it.
 *
 * No dashed border. A dashed rectangle says "something is missing here" —
 * which is technically true and completely unhelpful; it frames the absence
 * instead of resolving it. What resolves it is a sentence explaining what goes
 * here and a control that puts something there.
 *
 * The icon sits in a filled inset square rather than floating at 48px. A large
 * outline glyph alone in whitespace is the most recognisable template empty
 * state there is, and it is doing decoration's job while claiming to be
 * information.
 *
 * Vertically generous but not centred in the viewport: the block sits in the
 * upper half of the space, where the eye lands after reading the page title.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  titleAs: Heading = 'h2',
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-16 text-center', className)}>
      {Icon && (
        <div className="mb-5 grid size-10 place-items-center rounded-lg bg-inset">
          <Icon className="size-5 text-tertiary" strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}

      <Heading className="text-h3">{title}</Heading>

      {description && (
        <p className="mt-2 max-w-sm text-body-sm text-secondary text-pretty">{description}</p>
      )}

      {action && <div className="mt-6 flex items-center gap-3">{action}</div>}
    </div>
  );
}
