import type { ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/utils/cn';

interface SidebarGroupProps {
  label?: string | undefined;
  collapsed: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * A labelled block of navigation rows.
 *
 * Expanded, the group is announced by a real heading and separated by space.
 * Collapsed, there is no room for a heading — so the grouping is carried by a
 * hairline instead of being dropped. Losing the structure entirely is what
 * makes most icon rails feel like an undifferentiated column of glyphs; the
 * rule keeps the same three-then-one rhythm the expanded panel has.
 *
 * The `<ul>` is labelled by the heading via `aria-labelledby`, so a screen
 * reader reads "Workspace, list, 3 items" rather than three orphaned links.
 */
export function SidebarGroup({ label, collapsed, children, className }: SidebarGroupProps) {
  const headingId = useId();

  return (
    <div className={cn(className)}>
      {label &&
        (collapsed ? (
          <div className="mx-auto my-3 h-px w-6 bg-line" aria-hidden="true" />
        ) : (
          <h2
            id={headingId}
            className="mb-1 px-2.5 text-micro font-medium tracking-[0.06em] text-tertiary uppercase"
          >
            {label}
          </h2>
        ))}

      <ul
        // When collapsed the heading is not rendered, so fall back to a direct
        // label rather than pointing at an element that does not exist.
        {...(label && !collapsed ? { 'aria-labelledby': headingId } : label ? { 'aria-label': label } : {})}
        className={cn('flex flex-col', collapsed ? 'gap-1' : 'gap-0.5')}
      >
        {children}
      </ul>
    </div>
  );
}
