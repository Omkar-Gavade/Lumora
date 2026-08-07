import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Container } from './Container';
import { Button } from '@/components/ui/Button';

interface Props {
  children: ReactNode;
  /** Rendered instead of the default panel — used for narrower boundaries. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Still a class component: `componentDidCatch` has no hook equivalent, and
 * this is the one place a class is the correct tool rather than legacy.
 *
 * Placed around the route tree so a render failure in one page leaves the app
 * shell intact and offers a way out, rather than unmounting to a blank screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Replaced by a real reporting client later; the shape is what a provider
    // like Sentry expects, so the swap is one function call.
    console.error('[Lumora] Unhandled render error', error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <Container className="flex min-h-dvh items-center py-24">
        <div className="mx-auto max-w-md text-center">
          <p className="font-mono text-caption text-tertiary">Error</p>
          <h1 className="mt-4 text-h2">Something went wrong on our side</h1>
          <p className="mt-4 text-body text-secondary text-pretty">
            This page failed to render. Reloading usually fixes it. If it keeps happening,
            let us know what you were doing.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button variant="primary" size="lg" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="secondary" size="lg" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </div>
        </div>
      </Container>
    );
  }
}
