import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorFallback } from './ErrorFallback';

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

    // The panel itself lives in `ErrorFallback`, shared with the 404 and 500
    // pages so all three failure screens keep identical proportions.
    return (
      <div className="flex min-h-dvh items-center">
        <ErrorFallback error={error} onReset={this.reset} />
      </div>
    );
  }
}
