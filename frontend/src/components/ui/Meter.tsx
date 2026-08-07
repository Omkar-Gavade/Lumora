import { cn } from '@/lib/utils/cn';

interface MeterProps {
  /** 0–1. Clamped, so a backend that reports 105% cannot overflow the track. */
  value: number;
  label: string;
  className?: string;
}

/**
 * A usage bar. `role="meter"` rather than `progressbar`: this is a measurement
 * of a static quantity, not the progress of an operation, and screen readers
 * announce the two differently.
 *
 * The fill turns amber past 75% and red past 90%. That is the one place a
 * semantic color is allowed here — it is state, not decoration, and it is the
 * only warning a user gets before an upload starts failing.
 */
export function Meter({ value, label, className }: MeterProps) {
  const ratio = Math.min(Math.max(value, 0), 1);
  const percent = Math.round(ratio * 100);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${percent}% used`}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-inset', className)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width,background-color] duration-500',
          'ease-[var(--ease-decelerate)]',
          ratio >= 0.9 ? 'bg-danger' : ratio >= 0.75 ? 'bg-warning' : 'bg-secondary',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
