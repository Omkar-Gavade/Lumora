import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { StatusPage } from '@/components/common/StatusPage';
import { Button } from '@/components/ui/Button';

/**
 * The public 404, rendered inside the marketing layout.
 *
 * Its authenticated twin lives in `AppNotFoundPage` and shares this exact
 * panel through `StatusPage` — same words, same proportions, different
 * surrounding chrome, because a signed-in user should keep their navigation
 * when they hit a dead end rather than being dumped onto the marketing site.
 */
export function NotFoundPage() {
  useDocumentTitle('Page not found — Lumora');

  return (
    <StatusPage
      code="404"
      title="This page doesn’t exist"
      description="The link may be out of date, or the page may have moved."
      className="min-h-[60vh]"
      actions={
        <>
          <Button asChild variant="primary" size="lg">
            <Link to={ROUTES.home}>Back to home</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link to={ROUTES.login}>Sign in</Link>
          </Button>
        </>
      }
    />
  );
}
