import { forwardRef, type InputHTMLAttributes } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Native checkbox kept in the accessibility tree (`peer`, visually hidden but
 * not `display: none`) with a styled box painted on top. Keyboard, form
 * submission, and screen-reader behavior stay native.
 */
export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <span className="relative inline-grid size-4 shrink-0 place-items-center">
        <input
          ref={ref}
          type="checkbox"
          className="peer absolute inset-0 size-full cursor-pointer opacity-0"
          {...props}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none grid size-4 place-items-center rounded-sm border border-line-strong',
            'bg-raised transition-all duration-150 ease-[var(--ease-standard)]',
            'peer-hover:border-ring',
            'peer-checked:border-ink-solid peer-checked:bg-ink-solid',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
            'peer-disabled:opacity-50',
            // Targets the nested icon: `peer-checked:` alone only matches
            // siblings, and the icon is a child of this sibling.
            'peer-checked:[&>svg]:opacity-100',
            className,
          )}
        >
          <Check className="size-3 stroke-[3] text-on-ink opacity-0 transition-opacity duration-150" />
        </span>
      </span>
    );
  },
);
