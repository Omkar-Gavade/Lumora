import { cva, type VariantProps } from 'class-variance-authority';
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils/cn';
import { Spinner } from './Spinner';

/**
 * Button hierarchy:
 *   primary   — ink (near-black light / near-white dark). One per view.
 *   secondary — hairline border on canvas. The workhorse.
 *   ghost     — no chrome until hover. Nav and toolbars.
 *   danger    — destructive only.
 *   link      — inline text action.
 *
 * The primary action is intentionally NOT the accent color. A saturated CTA
 * blob is the fastest way to look like a template; ink reads as expensive.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium cursor-pointer select-none',
    'transition-[background-color,border-color,color,opacity,transform] duration-150',
    'ease-[var(--ease-standard)]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    'active:scale-[0.985]',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-ink-solid text-on-ink hover:bg-ink-solid-hover',
        secondary:
          'border border-line-default bg-raised text-primary hover:bg-hover hover:border-line-strong',
        ghost: 'text-secondary hover:bg-hover hover:text-primary',
        danger: 'bg-danger text-white hover:opacity-90',
        link: 'px-0 text-accent underline decoration-transparent underline-offset-4 hover:decoration-current',
      },
      size: {
        sm: 'h-9 rounded-md px-3.5 text-body-sm',
        md: 'h-10 rounded-md px-4 text-body-sm',
        lg: 'h-11 rounded-lg px-5 text-body-sm',
      },
      full: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', full: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /**
   * Render the button's styling onto its single child instead of a <button>.
   * Used for links that should look like buttons — an <a> styled as a button
   * keeps real link semantics (middle-click, open in new tab, right-click),
   * which a <button onClick={navigate}> silently breaks.
   */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    full,
    loading = false,
    iconLeft,
    iconRight,
    children,
    disabled,
    asChild = false,
    ...props
  },
  ref,
) {
  const classes = cn(buttonVariants({ variant, size, full }), className);

  if (asChild) {
    const child = Children.only(children) as ReactElement<{ className?: string }>;
    if (!isValidElement(child)) {
      throw new Error('<Button asChild> expects exactly one React element child.');
    }
    return cloneElement(child, {
      className: cn(classes, child.props.className),
    });
  }

  return (
    <button
      ref={ref}
      className={classes}
      disabled={disabled || loading}
      // Announce the busy state rather than only showing a spinner.
      aria-busy={loading || undefined}
      {...props}
    >
      {/* The label keeps its box while loading, so the button never resizes
          mid-click — a width jump reads as a broken control. */}
      <span className={cn('inline-flex items-center gap-2', loading && 'invisible')}>
        {iconLeft}
        {children}
        {iconRight}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner className="size-4" />
          <span className="sr-only">Loading</span>
        </span>
      )}
    </button>
  );
});
