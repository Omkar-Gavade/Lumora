import { Suspense, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { cn } from '@/lib/utils/cn';
import { SessionProvider } from '@/app/providers/SessionProvider';
import { SidebarProvider } from '@/app/providers/SidebarProvider';
import { CommandPalette } from '@/components/common/CommandPalette';
import { AppHeader } from './AppHeader';
import { DesktopSidebar, MobileSidebar } from './sidebar/Sidebar';

/**
 * The authenticated shell.
 *
 * `h-dvh overflow-hidden` at the root, with scrolling delegated to regions
 * inside it. `dvh` rather than `vh` because mobile browser chrome makes `vh`
 * overflow, which is what puts a chat composer underneath the keyboard.
 *
 * The sidebar and header live *outside* the `<Outlet />`, so navigating between
 * pages never remounts them: no flicker on the active indicator, no scroll
 * position lost in the conversation list, no re-running of the collapse
 * animation. This is the structural reason the shell is built before the
 * features rather than extracted from them afterwards.
 */
function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
    ⌘K / Ctrl-K, registered once at the shell rather than per page.

    Bound on `keydown` at the document with `preventDefault`, because in
    several browsers ⌘K is a native shortcut (focus the address bar's search)
    and losing the app to the URL bar mid-task is worse than having no
    shortcut at all.
  */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      {/* First tab stop in the app. Without it, reaching page content from the
          keyboard costs a pass through every navigation row, on every page. */}
      <a
        href="#main"
        className={cn(
          'sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-70',
          'focus:rounded-md focus:bg-ink-solid focus:px-4 focus:py-2',
          'focus:text-caption focus:font-medium focus:text-on-ink',
        )}
      >
        Skip to content
      </a>

      <DesktopSidebar />
      <MobileSidebar />

      {/* `min-w-0` is load-bearing: without it a wide table inside the content
          column would push the flex track past the viewport instead of
          scrolling, and the whole shell would gain a horizontal scrollbar. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader onOpenPalette={() => setPaletteOpen(true)} />

        <main
          id="main"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
        >
          {/*
            Page chunks suspend here rather than at the root, so the sidebar
            and header survive a route change instead of being replaced by a
            skeleton and rebuilt.

            The fallback is an empty region on purpose. These chunks are a few
            kilobytes behind an already-warm connection; a spinner that appears
            and disappears inside 80ms reads as a flicker, and the absence of
            one reads as instant.
          */}
          <Suspense fallback={<div className="flex-1" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Mounted on open so it starts empty every time — see CommandPalette. */}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

export function AppLayout() {
  return (
    <SessionProvider>
      {/* Inside the router, because it closes the drawer on navigation. */}
      <SidebarProvider>
        <AppShell />
      </SidebarProvider>
    </SessionProvider>
  );
}
