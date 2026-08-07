import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

interface FieldErrorProps {
  id?: string;
  children: string;
  className?: string;
}

/**
 * The single rendering of a field-level error, so every one on the site has the
 * same icon, colour, spacing, and announcement behaviour. Written once because
 * the checkbox error and the input errors were drifting apart immediately.
 */
export function FieldError({ id, children, className }: FieldErrorProps) {
  return (
    <p
      id={id}
      role="alert"
      className={cn('flex items-start gap-1.5 text-caption text-danger', className)}
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}
