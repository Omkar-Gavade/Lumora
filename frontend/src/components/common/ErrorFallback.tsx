import { Link } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { Button } from '@/components/ui/Button';
import { StatusPage } from './StatusPage';

interface ErrorFallbackProps {
  error: Error;
  /** Re-mounts the subtree that threw. */
  onReset: () => void;
}

/**
 * What an error boundary renders.
 *
 * Two actions, in order of how much they cost the user. *Try again* re-mounts
 * only the subtree that threw and keeps everything else — the sidebar, the
 * theme, any unsaved state elsewhere — which resolves the large class of
 * failures caused by one bad response. *Reload* is the bigger hammer, offered
 * second because it throws that state away.
 *
 * The stack goes behind a `<details>`. Rendering it inline turns a recoverable
 * moment into something that looks like the app is broken beyond use; hiding
 * it entirely means the one user who could usefully report it cannot. Closed
 * by default, one click away.
 *
 * The raw message is shown here and nowhere else in the product. A message
 * originating from the API is mapped through the copy table first — this is a
 * *render* error, which is ours, and there is no user-facing translation of a
 * component that threw.
 */
export function ErrorFallback({ error, onReset }: ErrorFallbackProps) {
  return (
    <StatusPage
      code="Error"
      title="Something went wrong on our side"
      description="This part of the page failed to render. Trying again usually fixes it — if it keeps happening, tell us what you were doing."
      detail={error.stack ?? error.message}
      actions={
        <>
          <Button variant="primary" size="lg" onClick={onReset}>
            Try again
          </Button>
          <Button variant="secondary" size="lg" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
          <Button asChild variant="ghost" size="lg" className="sm:hidden">
            <Link to={ROUTES.home}>Go home</Link>
          </Button>
        </>
      }
    />
  );
}
