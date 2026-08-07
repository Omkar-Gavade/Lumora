import { useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { Logo } from '@/components/common/Logo';
import { ThemeToggle } from '@/components/common/ThemeToggle';

/**
 * One task per screen, nothing to click away to.
 *
 * No split-screen, no illustration panel, no gradient. A marketing panel beside
 * a login form is decoration for a user who has already decided — it only adds
 * something to look at while they are trying to type a password.
 */
export function AuthLayout() {
  /*
    Tints the page so the auth card has a surface to lift off.

    `--bg-raised` is pure white in light mode — identical to `--bg-canvas` — so
    on an untinted page the card is defined by its hairline alone and reads as a
    stray outline rather than a surface.

    This is set on <body> rather than on the wrapper below because the scrollbar
    gutter and the overscroll area are painted from the body's background: a
    tinted inner div leaves a white strip down the right edge. The tint itself
    inverts per theme — see the `[data-surface='auth']` rules in globals.css.
  */
  useEffect(() => {
    document.body.dataset.surface = 'auth';
    return () => {
      delete document.body.dataset.surface;
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between px-6 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>

      {/* Slightly above optical center — a perfectly centered card sits low to
          the eye, especially on tall viewports. */}
      <main id="main" className="flex flex-1 items-start justify-center px-6 pt-10 pb-16 sm:pt-16">
        <div className="w-full max-w-[27rem]">
          <Outlet />
        </div>
      </main>

      <footer className="shrink-0 px-6 pb-8 sm:px-8">
        <div className="mx-auto flex max-w-[27rem] items-center justify-center gap-5 text-caption text-tertiary">
          <Link
            to={ROUTES.privacy}
            className="rounded-xs transition-colors hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Privacy
          </Link>
          <span aria-hidden="true" className="size-0.5 rounded-full bg-line-strong" />
          <Link
            to={ROUTES.terms}
            className="rounded-xs transition-colors hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Terms
          </Link>
        </div>
      </footer>
    </div>
  );
}
