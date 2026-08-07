import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

const iconButton = cva(
  [
    'relative grid shrink-0 cursor-pointer place-items-center rounded-md',
    'transition-colors duration-150 ease-[var(--ease-standard)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        ghost: 'text-secondary hover:bg-hover hover:text-primary',
        /* For controls sitting on the sidebar's tinted panel, where the canvas
           hover value is almost invisible. */
        sidebar: 'text-secondary hover:bg-sidebar-hover hover:text-primary',
      },
      size: {
        /* 36px visual box. The 44px touch minimum is met by the parent header
           and sidebar rows, which are 44px tall on touch viewports — inflating
           every icon button to 44px instead would wreck the 56px bar. */
        md: 'size-9',
        lg: 'size-10',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButton> {
  /** Required. An icon-only control with no accessible name is unusable with a
   *  screen reader, so this is not optional at the type level. */
  label: string;
  children: ReactNode;
  /** Suppresses the native tooltip — use when a richer `Tooltip` wraps it. */
  noTitle?: boolean;
}

/**
 * The square, icon-only sibling of `Button`. Separate rather than a `Button`
 * size, because it has a different contract: a mandatory accessible name, a
 * fixed aspect ratio, and no label slot.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, label, children, noTitle = false, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={noTitle ? undefined : label}
      className={cn(iconButton({ variant, size }), className)}
      {...props}
    >
      {children}
    </button>
  );
});
