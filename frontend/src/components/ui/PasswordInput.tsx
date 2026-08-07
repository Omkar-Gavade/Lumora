import { useState, forwardRef } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Input, type InputProps } from './Input';

/**
 * Password field with a reveal toggle. The toggle is a real button so it is
 * reachable by keyboard, and its label changes with state so a screen reader
 * announces what pressing it will do.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  function PasswordInput({ className, ...props }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          // Not in the tab order: it duplicates no information and would sit
          // between the password field and the submit button.
          tabIndex={-1}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className={cn(
            'absolute inset-y-0 right-0 grid w-10 cursor-pointer place-items-center',
            'text-tertiary transition-colors duration-150 hover:text-primary',
            'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
            'rounded-r-md',
          )}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    );
  },
);
