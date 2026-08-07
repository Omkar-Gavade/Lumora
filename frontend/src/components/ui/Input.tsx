import type { InputHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/**
 * Inputs get a real border rather than a filled grey box: on a white canvas a
 * hairline reads as "editable" without adding a second surface color. The
 * focus treatment is a ring plus a border darkening — the ring alone can be
 * missed against a busy background.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-10 w-full rounded-md border bg-raised px-3 text-body-sm text-primary',
        'transition-[border-color,box-shadow] duration-150 ease-[var(--ease-standard)]',
        'placeholder:text-tertiary',
        'focus:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25',
        'disabled:cursor-not-allowed disabled:bg-inset disabled:text-tertiary',
        invalid
          ? 'border-danger focus-visible:border-danger focus-visible:ring-danger/25'
          : 'border-line-default hover:border-line-strong',
        className,
      )}
      {...props}
    />
  );
});
