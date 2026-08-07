import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { ScrollContainer } from './ScrollContainer';
import { ContentContainer } from './ContentContainer';

interface PageContainerProps {
  /** Sets the tab title. Required, so no page can ship without one. */
  title: string;
  children: ReactNode;
  width?: 'app' | 'prose' | 'full';
  /**
   * Turns off the scroll region and the vertical padding, handing full control
   * of the column to the page. Chat needs this: its thread scrolls but its
   * composer does not.
   */
  bare?: boolean;
  className?: string;
}

/**
 * The contract every authenticated page signs.
 *
 * A page renders a `PageContainer` and its content, and gets the tab title,
 * the scroll region, the measure, and the vertical rhythm for free. That is
 * the whole point of building the shell first: the next four features are
 * written against this, so none of them has an opinion about layout, and none
 * of them can drift.
 *
 * Vertical padding is 32px top, 64px bottom. The asymmetry is deliberate — a
 * scrolled page that ends flush against the viewport edge reads as truncated,
 * and the extra space at the bottom is what tells the eye the content is over.
 */
export function PageContainer({
  title,
  children,
  width = 'app',
  bare = false,
  className,
}: PageContainerProps) {
  useDocumentTitle(`${title} — Lumora`);

  if (bare) {
    return <div className={cn('flex min-h-0 flex-1 flex-col', className)}>{children}</div>;
  }

  return (
    <ScrollContainer>
      <ContentContainer width={width} className={cn('py-8 pb-16', className)}>
        {children}
      </ContentContainer>
    </ScrollContainer>
  );
}
