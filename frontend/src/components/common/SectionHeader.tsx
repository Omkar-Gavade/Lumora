import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface SectionHeaderProps {
  /** Small uppercase label. Names the section without competing with the title. */
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  align?: 'left' | 'center';
  className?: string;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        align === 'center' ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl',
        className,
      )}
    >
      {eyebrow && (
        <p className="mb-4 text-micro font-medium tracking-[0.08em] text-tertiary uppercase">
          {eyebrow}
        </p>
      )}
      <h2 className="text-h2 sm:text-h1">{title}</h2>
      {description && (
        <p className="mt-4 text-body-lg text-secondary text-pretty">{description}</p>
      )}
    </div>
  );
}
