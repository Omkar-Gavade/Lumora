import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface StatusPageProps {
  /** The status or category, set in mono — "404", "500", "Error". */
  code: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  /** Optional technical detail, collapsed by default. */
  detail?: string | undefined;
  className?: string;
}

/**
 * One layout for every dead end: 404, 500, and the render-error boundary.
 *
 * Sharing the geometry is not just DRY. These three screens are the ones a
 * user meets at their least patient, and if they each had their own
 * proportions the product would feel like it fell apart precisely when it
 * failed. Same measure, same rhythm, same tone — the failure is contained,
 * and the interface around it is visibly still intact.
 *
 * The mono code line replaces the giant "404" that usually anchors these
 * pages. A 120px numeral is a decorative treatment of bad news; the number
 * matters to whoever is debugging, and to nobody else.
 *
 * Copy rule the three pages share: say what happened, then say what to do.
 * Never apologise twice, and never blame the user's link.
 */
export function StatusPage({
  code,
  title,
  description,
  actions,
  detail,
  className,
}: StatusPageProps) {
  return (
    <div className={cn('flex w-full items-center justify-center px-6 py-24', className)}>
      <div className="w-full max-w-md text-center">
        <p className="font-mono text-caption text-tertiary">{code}</p>
        <h1 className="mt-4 text-h2 text-balance">{title}</h1>
        <div className="mt-4 text-body text-secondary text-pretty">{description}</div>

        {actions && (
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {actions}
          </div>
        )}

        {detail && (
          <details className="mt-10 text-left">
            <summary
              className={cn(
                'cursor-pointer list-none text-caption text-tertiary select-none',
                'transition-colors hover:text-secondary',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              )}
            >
              Technical details
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-inset p-4 font-mono text-caption text-secondary">
              {detail}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
