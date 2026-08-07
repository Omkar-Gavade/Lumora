import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Container } from '@/components/common/Container';
import { Button } from '@/components/ui/Button';

export function NotFoundPage() {
  useDocumentTitle('Page not found — Lumora');

  return (
    <Container className="flex min-h-[60vh] items-center py-32">
      <div className="mx-auto max-w-md text-center">
        <p className="font-mono text-caption text-tertiary">404</p>
        <h1 className="mt-4 text-h1">This page doesn&rsquo;t exist</h1>
        <p className="mt-4 text-body text-secondary text-pretty">
          The link may be out of date, or the page may have moved.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild variant="primary" size="lg">
            <Link to={ROUTES.home}>Back to home</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link to={ROUTES.login}>Sign in</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
