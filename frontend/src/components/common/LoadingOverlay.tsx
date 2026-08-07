import { cn } from '@/lib/utils/cn';
import { Spinner } from '@/components/ui/Spinner';

interface LoadingOverlayProps {
  /**
   * Names the operation. Required above one second per the feedback rules —
   * "Loading" is a spinner with extra steps, "Indexing your document" is an
   * answer to the question the user is actually asking.
   */
  label: string;
  /** Covers the nearest positioned ancestor instead of the viewport. */
  inset?: boolean;
  className?: string;
}

/**
 * A blocking indicator for work already in flight.
 *
 * Uses a translucent canvas rather than a scrim: the content underneath stays
 * legible, which matters because this covers something the user was reading a
 * moment ago and will be reading again. A dark scrim here would say "a dialog
 * has opened", which is a different and wrong message.
 *
 * `aria-live="polite"` with `role="status"`, so the operation is announced
 * once rather than interrupting whatever a screen reader is mid-sentence on.
 */
export function LoadingOverlay({ label, inset = false, className }: LoadingOverlayProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fade-in z-50 grid place-items-center bg-canvas/70',
        inset ? 'absolute inset-0' : 'fixed inset-0',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3">
        <Spinner className="size-5 text-tertiary" />
        <p className="text-body-sm text-secondary">{label}</p>
      </div>
    </div>
  );
}
