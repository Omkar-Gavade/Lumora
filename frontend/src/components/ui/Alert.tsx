import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const ICONS = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
} as const;

interface AlertProps {
  tone?: keyof typeof ICONS;
  children: ReactNode;
  className?: string;
}

/**
 * Form-level message, for failures that belong to the submission rather than
 * to a single field ("Email or password is incorrect").
 *
 * `role="alert"` on errors so it is announced immediately; success and info use
 * `status`, which is polite and does not interrupt.
 */
export function Alert({ tone = 'error', children, className }: AlertProps) {
  const Icon = ICONS[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-body-sm text-pretty',
        tone === 'error' && 'border-danger/30 bg-danger/5 text-danger',
        tone === 'success' && 'border-success/30 bg-success/5 text-secondary',
        tone === 'info' && 'border-line bg-inset text-secondary',
        className,
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'success' && 'text-success',
          tone === 'info' && 'text-tertiary',
        )}
        aria-hidden="true"
      />
      <div>{children}</div>
    </div>
  );
}
