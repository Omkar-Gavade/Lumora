import { NavLink } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Tooltip } from '@/components/ui/Tooltip';

interface SidebarItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
  /** `end` on the NavLink — off for sections that own child routes. */
  matchNested?: boolean;
  badge?: number | undefined;
}

/**
 * One navigation row.
 *
 * The active treatment is three signals at once, deliberately:
 *
 *   surface — the row lifts to `--bg-sidebar-active`, which in light mode is
 *             the white of the reading canvas. The selected row is a piece of
 *             the page it opens, sitting in the panel.
 *   label   — steps up to `--text-primary` and medium weight.
 *   icon    — takes the accent. This is the one accent element in the whole
 *             sidebar, and there is never more than one on screen, which is
 *             what keeps a single indigo glyph reading as *meaning* rather
 *             than as decoration.
 *
 * Three signals rather than one because any single one is arguable at a
 * glance: a fill alone is ambiguous with hover, a weight change alone is
 * invisible in peripheral vision, and a color change alone fails for anyone
 * who cannot separate the hues. Together they are unmistakable, and none of
 * them is loud.
 *
 * Every row carries `border border-transparent` whether or not it is active,
 * so the active row's hairline cannot change the row's height by two pixels
 * and shove the rest of the list down.
 */
export function SidebarItem({
  to,
  label,
  icon: Icon,
  collapsed,
  matchNested = false,
  badge,
}: SidebarItemProps) {
  return (
    <Tooltip label={label} side="right" disabled={!collapsed}>
      <NavLink
        to={to}
        end={!matchNested}
        className={({ isActive }) =>
          cn(
            'group relative flex items-center rounded-md border border-transparent',
            'text-body-sm',
            'transition-[background-color,border-color,color] duration-150 ease-[var(--ease-standard)]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            // 44px rows on touch viewports, 36px once there is a pointer. The
            // sidebar is the same component in the mobile drawer, and a 36px
            // tap target there would be a genuine accessibility failure.
            collapsed ? 'mx-auto size-10 justify-center' : 'h-11 gap-2.5 px-2.5 md:h-9',
            isActive
              ? 'border-line bg-sidebar-active font-medium text-primary shadow-e1'
              : 'text-secondary hover:bg-sidebar-hover hover:text-primary',
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon
              className={cn(
                'size-[1.125rem] shrink-0 transition-colors duration-150',
                isActive ? 'text-accent' : 'text-tertiary group-hover:text-secondary',
              )}
              strokeWidth={1.5}
              aria-hidden="true"
            />

            {/* Collapsed, the label still has to exist for assistive tech —
                the rail is icons, not a set of unnamed buttons. */}
            <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>

            {badge !== undefined && !collapsed && (
              <span className="ml-auto text-caption text-tertiary tabular">{badge}</span>
            )}
          </>
        )}
      </NavLink>
    </Tooltip>
  );
}
