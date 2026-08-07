import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ROUTES, SECTIONS } from '@/app/router/routes';
import { useScrolled } from '@/hooks/useScrolled';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { useLockBodyScroll } from '@/hooks/useLockBodyScroll';
import { Logo } from '@/components/common/Logo';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { Button } from '@/components/ui/Button';

/**
 * Four links, not seven. A marketing nav is a promise about how complicated
 * the product is — every extra item spends that budget. Privacy and the FAQ
 * are reachable by scroll and from the footer.
 */
const NAV_LINKS = [
  { id: SECTIONS.features, label: 'Features' },
  { id: SECTIONS.howItWorks, label: 'How it works' },
  { id: SECTIONS.whyRag, label: 'Why RAG' },
  { id: SECTIONS.useCases, label: 'Use cases' },
] as const;

const SPY_IDS = NAV_LINKS.map((link) => link.id);

export function Navbar() {
  const scrolled = useScrolled(8);
  const activeSection = useScrollSpy(SPY_IDS);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onHomepage = pathname === ROUTES.home;

  useLockBodyScroll(menuOpen);

  /*
    Closing the sheet is done in the click handler, not in an effect watching
    the location. An effect that calls setState on every navigation fires an
    extra render pass on each one, and it does not even cover the common case:
    tapping an in-page anchor from the homepage changes only the hash, so the
    sheet would stay open over the section it just scrolled to.
  */
  const closeMenu = () => {
    setMenuOpen(false);
  };

  // Escape closes and returns focus to the trigger, so keyboard users are not
  // dropped at the top of the document.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  // Move focus into the sheet when it opens.
  useEffect(() => {
    if (menuOpen) panelRef.current?.focus();
  }, [menuOpen]);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-40',
        // The border is earned on scroll rather than worn at rest. Colors are
        // animated, never height or position — those would relayout per frame.
        'transition-[background-color,border-color,backdrop-filter] duration-300',
        'ease-[var(--ease-standard)] border-b',
        menuOpen
          ? // Fully opaque while the sheet is open: a translucent header over a
            // full-height panel lets page content ghost through the bar.
            'border-line bg-canvas'
          : scrolled
            ? 'border-line bg-canvas/80 backdrop-blur-xl backdrop-saturate-150'
            : 'border-transparent bg-transparent',
      )}
    >
      {/* Skip link: first tab stop on the page. */}
      <a
        href="#main"
        className={cn(
          'sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-6 focus:z-50',
          'focus:rounded-md focus:bg-ink-solid focus:px-4 focus:py-2',
          'focus:text-caption focus:font-medium focus:text-on-ink',
        )}
      >
        Skip to content
      </a>

      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-[var(--container-content)] items-center justify-between gap-6 px-6 sm:px-8"
      >
        <Logo />

        {/* Center links sit in their own flex row so the logo and the action
            cluster stay pinned to the container edges at every width. */}
        <ul className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => {
            const isActive = onHomepage && activeSection === link.id;
            return (
              <li key={link.id}>
                <a
                  href={`${ROUTES.home}#${link.id}`}
                  aria-current={isActive ? 'true' : undefined}
                  className={cn(
                    'group relative inline-flex h-9 items-center rounded-md px-3',
                    'text-body-sm transition-colors duration-150 ease-[var(--ease-standard)]',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    isActive ? 'text-primary' : 'text-secondary hover:text-primary',
                  )}
                >
                  {link.label}
                  {/* Active indicator: a hairline under the label, scaled in
                      from the center. transform only — no layout cost. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute inset-x-3 bottom-1 h-px origin-center bg-primary',
                      'transition-transform duration-300 ease-[var(--ease-standard)]',
                      isActive ? 'scale-x-100' : 'scale-x-0',
                    )}
                  />
                </a>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-1.5">
          <ThemeToggle />

          <Link
            to={ROUTES.login}
            className={cn(
              'hidden h-9 items-center rounded-md px-3 text-body-sm text-secondary sm:inline-flex',
              'transition-colors duration-150 hover:bg-hover hover:text-primary',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            Sign in
          </Link>

          <Button asChild size="sm" variant="primary" className="hidden sm:inline-flex">
            <Link to={ROUTES.signup}>Get started</Link>
          </Button>

          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            className={cn(
              'grid size-9 cursor-pointer place-items-center rounded-md text-secondary md:hidden',
              'transition-colors duration-150 hover:bg-hover hover:text-primary',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            {menuOpen ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </nav>

      {/* Mobile sheet: a full-height opaque panel below the bar, not an inline
          dropdown. An inline panel leaves the page visible beneath it, so hero
          buttons ghost through and it is unclear what is tappable. Fixed +
          opaque removes the ambiguity, and body scroll is locked while open. */}
      <div
        id="mobile-menu"
        ref={panelRef}
        tabIndex={-1}
        hidden={!menuOpen}
        className={cn(
          'fixed inset-x-0 top-16 bottom-0 z-40 flex flex-col overflow-y-auto',
          'bg-canvas md:hidden focus-visible:outline-none',
        )}
      >
        <ul className="flex flex-1 flex-col gap-1 px-6 py-6">
          {NAV_LINKS.map((link) => (
            <li key={link.id}>
              <a
                href={`${ROUTES.home}#${link.id}`}
                onClick={closeMenu}
                className="flex min-h-12 items-center rounded-md px-2 text-body-lg text-secondary transition-colors hover:bg-hover hover:text-primary"
              >
                {link.label}
              </a>
            </li>
          ))}
          <li>
            <Link
              to={ROUTES.privacy}
              onClick={closeMenu}
              className="flex min-h-12 items-center rounded-md px-2 text-body-lg text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              Privacy
            </Link>
          </li>
        </ul>

        {/* Pinned to the bottom, where a thumb rests. */}
        <div className="flex flex-col gap-3 border-t border-line px-6 py-6">
          <Button asChild variant="primary" size="lg" full>
            <Link to={ROUTES.signup} onClick={closeMenu}>
              Get started
            </Link>
          </Button>
          <Button asChild variant="secondary" size="lg" full>
            <Link to={ROUTES.login} onClick={closeMenu}>
              Sign in
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
