import { cn } from '@/lib/utils/cn';

/**
 * Rotation is the one animation that survives `prefers-reduced-motion`
 * suppression by design — the global rule zeroes duration, so this uses a
 * transform on an SVG stroke that still reads as "working" when static.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('size-4 animate-spin', className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
