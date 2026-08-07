import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';

interface AuthCardProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Rendered under the card — the "Already have an account?" line. */
  footer?: ReactNode;
}

/**
 * The auth task in a surface of its own.
 *
 * Built from the existing `Card` primitive rather than a bespoke panel, so it
 * inherits the same radius and hairline as every card on the marketing page —
 * an auth screen with its own frame treatment is how two-designer drift starts.
 *
 * The only addition is `shadow-e1`. In light mode the raised surface is the same
 * white as the canvas, so without a shadow the card would be defined by its
 * hairline alone and read as a stray outline. `shadow-e1` is the lightest step
 * in the scale (1px, 5% black); in dark mode the lift comes from `bg-raised`
 * sitting above the darker canvas, and the shadow simply stops being visible.
 * This is the deliberate exception to "most surfaces have no shadow" — it is
 * the one element on the page, and it is meant to float.
 *
 * The footer sits outside the card: it is navigation away from this task, not
 * part of it, and keeping it out means the card contains exactly one job.
 */
export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div>
      <Card className="p-6 shadow-e1 sm:p-8">
        <div className="mb-7">
          <h1 className="text-[1.625rem] leading-tight tracking-[-0.025em] sm:text-[1.75rem]">
            {title}
          </h1>
          {description && (
            <p className="mt-2 text-body-sm text-secondary text-pretty">{description}</p>
          )}
        </div>

        {children}
      </Card>

      {footer && <div className="mt-6 text-center text-body-sm text-secondary">{footer}</div>}
    </div>
  );
}
