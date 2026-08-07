import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Logo } from '@/components/common/Logo';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { StatusPage } from '@/components/common/StatusPage';
import { Button } from '@/components/ui/Button';

/**
 * The 500.
 *
 * Standalone rather than inside a layout: a server failure is exactly the
 * moment the surrounding chrome is least trustworthy, and a header full of
 * controls that may also be failing is worse than no header. What is left is
 * the mark — enough to confirm you are still on Lumora and not at a proxy's
 * error page — and the theme toggle, which is purely local and always works.
 *
 * Copy owns the failure ("on our side") and does not ask the user to check
 * their connection. Blaming the network for a 500 is the tell of an error
 * page written by someone who never had to read one.
 *
 * *Try again* reloads rather than routing, because a client-side navigation
 * would not re-attempt whatever failed.
 */
export function ServerErrorPage() {
  useDocumentTitle('Something went wrong — Lumora');

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between px-6 sm:px-8">
        <Logo />
        <ThemeToggle />
      </header>

      <main id="main" className="flex flex-1 items-center">
        <StatusPage
          code="500"
          title="Something went wrong on our side"
          description="The request didn’t complete. Nothing you were working on has been lost — try again in a moment."
          actions={
            <>
              <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
                Try again
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link to={ROUTES.home}>Back to home</Link>
              </Button>
            </>
          }
        />
      </main>
    </div>
  );
}
