import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useSidebar } from '@/app/providers/SidebarProvider';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { IconButton } from '@/components/ui/IconButton';
import { SidebarContent } from './SidebarContent';

/**
 * The permanent sidebar, `md` and up.
 *
 * Width animates rather than the panel sliding and the content re-flowing
 * behind it. Animating `width` costs a layout pass per frame, which the design
 * system warns against — this is the deliberate exception, and it is worth it:
 * the alternative is a `translateX` panel plus an animated margin on the
 * content column, which is *two* animated properties producing the same layout
 * work, with an extra failure mode when the two fall out of sync mid-flight.
 * One element, one property, 200ms.
 */
export function DesktopSidebar() {
  const { collapsed } = useSidebar();

  return (
    <aside
      className={cn(
        'relative z-30 hidden shrink-0 border-r border-line md:block',
        'transition-[width] duration-200 ease-[var(--ease-standard)]',
      )}
      style={{ width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)' }}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}

/**
 * The overlay drawer, below `md`.
 *
 * Kept mounted and translated off-canvas rather than mounted on open, so the
 * close transition exists at all — an overlay that slides in and then vanishes
 * on a frame boundary reads as a crash. `inert` is what makes that safe: while
 * closed the whole subtree is removed from the tab order and the accessibility
 * tree, so an off-screen panel cannot swallow a Tab press or be read out by a
 * screen reader sitting behind the page.
 *
 * The drawer is 288px, not the desktop 264px. Thumbs are less precise than a
 * cursor and the rows are 44px here; the extra 24px is what keeps the account
 * row and the storage figure from feeling wedged against the edge.
 */
export function MobileSidebar() {
  const { drawerOpen, closeDrawer, isMobile } = useSidebar();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useLockBodyScroll(drawerOpen && isMobile);

  // Focus moves into the drawer on open. Without it the next Tab continues
  // from the header button, behind the scrim.
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  /*
    Focus trap. A drawer over a scrim is a modal surface: Tab must cycle within
    it, or focus walks out onto content the user cannot see and the scrim will
    not let them click.
  */
  useEffect(() => {
    if (!drawerOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, closeDrawer]);

  return (
    <div className="md:hidden">
      {/* Scrim. Opacity only — a backdrop-blur here would cost a full-screen
          GPU pass on the least powerful devices in the lineup, to obscure
          content the panel already covers. */}
      {/* The scrim is a pointer convenience, not a control. It is aria-hidden
          and carries no keyboard affordance on purpose: the drawer already
          closes on Escape and on its own close button, and adding a focusable
          scrim would insert a nameless tab stop in front of the panel. */}
      <div
        onClick={closeDrawer}
        aria-hidden="true"
        className={cn(
          'fixed inset-0 z-40 bg-scrim',
          'transition-opacity duration-200 ease-[var(--ease-standard)]',
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        inert={!drawerOpen}
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-[var(--sidebar-w-drawer)] border-r border-line',
          'transition-transform duration-250 ease-[var(--ease-standard)]',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Sits over the drawer's own identity row, in the corner a thumb
            reaches without crossing the panel. */}
        <IconButton
          ref={closeRef}
          label="Close navigation"
          variant="sidebar"
          onClick={closeDrawer}
          className="absolute top-2.5 right-2.5 z-10"
        >
          <X className="size-[1.125rem]" strokeWidth={1.5} aria-hidden="true" />
        </IconButton>

        <SidebarContent collapsed={false} />
      </div>
    </div>
  );
}
