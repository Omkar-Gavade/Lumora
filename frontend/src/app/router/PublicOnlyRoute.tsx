import { Navigate, Outlet, useSearchParams } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useAuth } from '@/app/providers/AuthProvider';
import { safeNextPath } from './safe-next';

/**
 * The inverse guard: keeps a signed-in user off the auth screens
 * (docs/02-frontend.md §4).
 *
 * Without it, someone already signed in who taps a stale "Sign in" link gets a
 * login form for the account they are currently using — and submitting it
 * starts a second session for no reason.
 *
 * Renders nothing while resolving rather than a skeleton: these are small
 * centred cards, and a full-shell skeleton flashing behind a login form would
 * be more jarring than a blank frame.
 */
export function PublicOnlyRoute() {
  const { status, user } = useAuth();
  const [searchParams] = useSearchParams();

  if (status === 'loading') return null;

  if (status === 'authenticated') {
    /*
      An unverified account goes to the verification screen, not into the app.

      This is what makes the signup flow land where docs/00-product.md §8
      specifies ("routed to /verify-email with 'check your inbox'"). Signup
      adopts a session and *then* navigates, so this guard re-renders first and
      its redirect wins the race — putting the destination here rather than
      relying on the order of a setState and a navigate is what makes the
      outcome deterministic instead of accidental.
    */
    if (user && !user.emailVerified) return <Navigate to={ROUTES.verifyEmail} replace />;

    // Honour the same `?next=` the protected guard sets, so an expired session
    // that re-authenticates lands back where it started — sanitized, because
    // the value arrives from the URL.
    return <Navigate to={safeNextPath(searchParams.get('next'), ROUTES.chat)} replace />;
  }

  return <Outlet />;
}
