import { useId, type ReactElement, cloneElement } from 'react';
import { cn } from '@/lib/utils/cn';
import { FieldError } from './FieldError';

interface FormFieldProps {
  label: string;
  /** Rendered right of the label — used for "Forgot password?". */
  labelAction?: ReactElement;
  hint?: string;
  error?: string | undefined;
  /**
   * Mark the control invalid without printing a message. For fields whose
   * requirements are already displayed next to them — repeating "Use at least
   * 12 characters" directly above a checklist item that says the same thing is
   * noise, and it makes the form feel like it is nagging.
   */
  invalid?: boolean | undefined;
  required?: boolean;
  className?: string;
  /** A single control. Receives id / aria-describedby / aria-invalid. */
  children: ReactElement<{
    id?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
    invalid?: boolean;
  }>;
}

/**
 * Owns the label↔control↔message wiring so no screen-reader association is
 * ever forgotten at a call site. Errors render next to the field, never only
 * in a summary at the top of the form.
 */
export function FormField({
  label,
  labelAction,
  hint,
  error,
  invalid,
  required,
  className,
  children,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const isInvalid = Boolean(error) || Boolean(invalid);
  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  const control = cloneElement(children, {
    id,
    invalid: isInvalid,
    'aria-invalid': isInvalid,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  });

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-caption font-medium text-primary">
          {label}
          {required && (
            <span className="text-tertiary" aria-hidden="true">
              {' '}
              *
            </span>
          )}
        </label>
        {labelAction}
      </div>

      {control}

      {hint && !error && (
        <p id={hintId} className="text-caption text-tertiary">
          {hint}
        </p>
      )}

      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
