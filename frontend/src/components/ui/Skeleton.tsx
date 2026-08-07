import { cn } from '@/lib/utils/cn';

/**
 * A placeholder block.
 *
 * Pulses opacity rather than sweeping a shimmer gradient across itself. A
 * shimmer is a moving highlight on a surface that is not there yet — it draws
 * the eye to nothing, and it is a gradient, which this system does not use.
 * The pulse is suppressed under `prefers-reduced-motion` by the global rule,
 * leaving a static grey block that still communicates "loading".
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-inset', className)} aria-hidden="true" />;
}
