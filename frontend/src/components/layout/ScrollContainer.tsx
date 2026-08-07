import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * The app's scrolling viewport.
 *
 * The shell pins `<html>`/`<body>` at viewport height and hands scrolling to
 * exactly one element per column. That is what lets a page pin a composer to
 * the bottom, or a table keep its header, without any of them fighting the
 * document scroll — and it is why every authenticated page must put its
 * content inside this rather than relying on the page growing.
 *
 * `overscroll-contain` stops a flick at the end of the list from chaining out
 * to the document and triggering pull-to-refresh mid-conversation.
 */
export const ScrollContainer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollContainer({ className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);
