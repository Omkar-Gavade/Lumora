import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/utils/cn';

/**
 * Inline text link. Underline is present but transparent at rest and revealed
 * on hover, so a paragraph full of links does not read as striped while the
 * accent color still marks them as interactive.
 */
export function TextLink({ className, ...props }: LinkProps) {
  return (
    <Link
      className={cn(
        'text-accent underline decoration-transparent underline-offset-[3px]',
        'transition-colors duration-150 hover:decoration-current',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-xs',
        className,
      )}
      {...props}
    />
  );
}
