import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils/cn';
import { ROUTES } from '@/app/router/routes';

/**
 * The mark is a crescent inside a rounded square — light emerging, which is
 * what "Lumora" means. Geometric so it stays legible at 16px, and drawn in
 * `currentColor` so it inverts with the theme instead of needing two assets.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-6', className)}
      aria-hidden="true"
      focusable="false"
    >
      <mask id="lumora-crescent">
        <rect width="24" height="24" fill="#fff" />
        <circle cx="15.4" cy="9.6" r="6.6" fill="#000" />
      </mask>
      <rect width="24" height="24" rx="6" fill="currentColor" />
      <circle
        cx="12"
        cy="12"
        r="6.6"
        className="fill-canvas"
        mask="url(#lumora-crescent)"
      />
    </svg>
  );
}

interface LogoProps {
  className?: string;
  /** Renders as plain content instead of a link — for the footer, where the
   *  wordmark is not a second navigation target. */
  asLink?: boolean;
}

export function Logo({ className, asLink = true }: LogoProps) {
  const content = (
    <>
      <LogoMark className="size-6 text-primary" />
      <span className="text-[1.0625rem] leading-none font-semibold tracking-[-0.02em] text-primary">
        Lumora
      </span>
    </>
  );

  const classes = cn('inline-flex items-center gap-2.5', className);

  if (!asLink) {
    return <span className={classes}>{content}</span>;
  }

  return (
    <Link
      to={ROUTES.home}
      aria-label="Lumora — home"
      className={cn(
        classes,
        'rounded-md transition-opacity duration-150 hover:opacity-70',
        'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
      )}
    >
      {content}
    </Link>
  );
}
