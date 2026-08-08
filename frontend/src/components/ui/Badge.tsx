import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'bg-inset text-secondary',
        outline: 'border border-line-default text-secondary',
        accent: 'bg-accent-subtle text-accent',
        success: 'bg-inset text-success',
        // The counterpart to `success`, on the same inset surface. FR-13
        // requires a failed document to read as failed at a glance; without
        // this the only options were a neutral pill that says nothing or an
        // accent one that reads as interactive.
        danger: 'bg-inset text-danger',
      },
      size: {
        sm: 'h-5 px-2 text-micro uppercase',
        md: 'h-7 px-3 text-caption',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md' },
  },
);

interface BadgeProps extends VariantProps<typeof badge> {
  children: ReactNode;
  className?: string;
}

export function Badge({ variant, size, className, children }: BadgeProps) {
  return <span className={cn(badge({ variant, size }), className)}>{children}</span>;
}
