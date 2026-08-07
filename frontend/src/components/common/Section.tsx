import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { useReveal } from '@/hooks/useReveal';
import { Container } from './Container';

interface SectionProps {
  id?: string;
  /** Adds the subtle background fill. Used to alternate section rhythm. */
  tone?: 'canvas' | 'subtle';
  /** Hairline above the section. Used instead of a tone change where a fill
   *  would be too heavy. */
  bordered?: boolean;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
}

/**
 * Vertical rhythm authority. Section padding is defined once here so no page
 * can drift to a one-off value — the usual cause of a landing page that feels
 * subtly uneven without anyone being able to say why.
 */
export function Section({
  id,
  tone = 'canvas',
  bordered = false,
  className,
  containerClassName,
  children,
}: SectionProps) {
  const ref = useReveal<HTMLElement>();

  return (
    <section
      id={id}
      ref={ref}
      className={cn(
        'reveal scroll-mt-24 py-20 sm:py-24 lg:py-32',
        tone === 'subtle' && 'bg-subtle',
        bordered && 'border-t border-line',
        className,
      )}
    >
      <Container className={containerClassName}>{children}</Container>
    </section>
  );
}
