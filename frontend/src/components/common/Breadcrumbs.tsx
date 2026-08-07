import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useBreadcrumbs } from '@/hooks/useBreadcrumbs';

/**
 * The header's answer to "where am I".
 *
 * The final crumb *is* the page title. There is no separate title in the bar,
 * because a 20px heading inside a 56px chrome strip competes with the real
 * `<h1>` forty pixels below it, and the user ends up reading the page name
 * twice before reaching the content.
 *
 * Below `md` only the final crumb survives. A three-level trail on a 375px
 * screen either wraps the bar to two lines or truncates every segment into
 * ambiguity; the ancestors are one back-gesture away, and the answer people
 * actually need on a phone is "what am I looking at".
 */
export function Breadcrumbs({ className }: { className?: string }) {
  const crumbs = useBreadcrumbs();
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;

          return (
            <Fragment key={crumb.label}>
              {index > 0 && (
                <li aria-hidden="true" className="hidden shrink-0 md:block">
                  <ChevronRight className="size-3.5 text-tertiary" strokeWidth={1.5} />
                </li>
              )}

              <li className={cn('min-w-0', !isLast && 'hidden md:block')}>
                {crumb.to ? (
                  <Link
                    to={crumb.to}
                    className={cn(
                      'block truncate rounded-xs text-body-sm text-secondary',
                      'transition-colors duration-150 hover:text-primary',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    )}
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current="page"
                    className="block truncate text-body-sm font-medium text-primary"
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
