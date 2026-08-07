import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { MEDIA_AT_LEAST_LG, MEDIA_BELOW_MD, useMediaQuery } from '@/hooks/useMediaQuery';

const STORAGE_KEY = 'lumora-sidebar';

type StoredPreference = 'expanded' | 'collapsed';

interface SidebarContextValue {
  /** Viewport is below `md`; the sidebar is an overlay drawer. */
  isMobile: boolean;
  /** The icon rail is showing. Always `false` on mobile — the drawer is either
   *  open at full width or not present at all. */
  collapsed: boolean;
  drawerOpen: boolean;
  toggle: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

function readStoredPreference(): StoredPreference | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'expanded' || stored === 'collapsed') return stored;
  } catch {
    /* private mode */
  }
  return null;
}

/**
 * Owns one piece of state with two very different presentations, because on
 * every real device it *is* one piece of state: "how much of the navigation am
 * I looking at right now."
 *
 * The breakpoint supplies the **default**, never the value. A tablet opens on
 * the icon rail because 264px out of 900px is a third of the screen; a desktop
 * opens expanded. But the moment the user touches the toggle their choice is
 * stored and the breakpoint stops having an opinion — a layout that keeps
 * re-deciding on resize is a layout that ignores you.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const isMobile = useMediaQuery(MEDIA_BELOW_MD);
  const isDesktop = useMediaQuery(MEDIA_AT_LEAST_LG);

  const [preference, setPreference] = useState<StoredPreference | null>(readStoredPreference);
  const { pathname } = useLocation();

  const collapsed = isMobile ? false : preference !== null ? preference === 'collapsed' : !isDesktop;

  /*
    The drawer stores the route it was opened *on*, not a boolean.

    That one substitution removes two effects. "Open" becomes a derived fact —
    the drawer is open while you are still where you opened it — so navigating
    closes it without anything having to watch for navigation, and every route
    change is covered identically: a nav row, a breadcrumb, the command
    palette, and the browser back button. A `useEffect` on `pathname` calling
    `setDrawerOpen(false)` would do the same job one render later, and would
    fire on every navigation for the 99% of them where the drawer is shut.

    `&& isMobile` closes it on the other axis for free: resizing past `md`
    while the drawer is open no longer strands `overflow: hidden` on <body>.
  */
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const drawerOpen = isMobile && drawerPath === pathname;

  const toggle = useCallback(() => {
    if (isMobile) {
      setDrawerPath((current) => (current === pathname ? null : pathname));
      return;
    }
    setPreference((current) => {
      const resolved = current !== null ? current === 'collapsed' : !isDesktop;
      const next: StoredPreference = resolved ? 'expanded' : 'collapsed';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode — the preference simply will not survive a reload */
      }
      return next;
    });
  }, [isMobile, isDesktop, pathname]);

  const openDrawer = useCallback(() => setDrawerPath(pathname), [pathname]);
  const closeDrawer = useCallback(() => setDrawerPath(null), []);

  const value = useMemo(
    () => ({ isMobile, collapsed, drawerOpen, toggle, openDrawer, closeDrawer }),
    [isMobile, collapsed, drawerOpen, toggle, openDrawer, closeDrawer],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error('useSidebar must be used within <SidebarProvider>');
  return context;
}
