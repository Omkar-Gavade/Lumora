import { BookOpen, FileText, MessageSquare, Settings, type LucideIcon } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /**
   * Matches child routes as well — `/app/chat/abc` keeps *Chat* active.
   * Off for leaf destinations, so a nested settings page does not light up
   * two rows at once.
   */
  matchNested?: boolean;
  /** Rendered as a count on the right edge of the row. Omit for none. */
  badge?: number;
}

export interface NavGroup {
  /**
   * The small uppercase label above the group. Omitted for the first group —
   * a heading over the very first item labels the obvious and costs 28px of
   * vertical space at the top of the panel, where space is most valuable.
   */
  label?: string;
  items: NavItem[];
}

/**
 * The navigation IS this array. Nothing about the sidebar's markup knows what
 * a "Documents" page is, so adding a destination is one entry here and a route
 * — never a change to a layout component.
 *
 * Two groups rather than one flat list: *Workspace* is where you do the work,
 * *Account* is where you configure it. That split is what lets the eye skip
 * straight to the half it wants instead of reading four labels every time.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { label: 'Chat', to: ROUTES.chat, icon: MessageSquare, matchNested: true },
      /*
        `BookOpen`, not `Library`. Library draws five books on a shelf, which
        at 18px with a 1.5 stroke collapses into four near-vertical strokes —
        it reads as a glitch, not an icon. Checked at render size rather than
        chosen from the icon grid, which is where that mistake is invisible.
      */
      { label: 'Knowledge Base', to: ROUTES.knowledge, icon: BookOpen, matchNested: true },
      { label: 'Documents', to: ROUTES.documents, icon: FileText, matchNested: true },
    ],
  },
  {
    label: 'Account',
    items: [{ label: 'Settings', to: ROUTES.settings, icon: Settings, matchNested: true }],
  },
];

/** Flat view, for the command palette and for breadcrumb resolution. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
