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
  const { status } = useAuth();
  const [searchParams] = useSearchParams();

  if (status === 'loading') return null;

  if (status === 'authenticated') {
    /*
      Signing up lands in the application, not on a verification screen.

      This guard used to divert an unverified account to /verify-email, which
      made registering a two-step flow whose second step depended on a mail
      round trip the user could not influence. The backend gate that made the
      diversion necessary is gone (see `api/middleware/authenticate.ts`), so
      the account that just registered goes where it was trying to go.
    */

    // Honour the same `?next=` the protected guard sets, so an expired session
    // that re-authenticates lands back where it started — sanitized, because
    // the value arrives from the URL.
    return <Navigate to={safeNextPath(searchParams.get('next'), ROUTES.chat)} replace />;
  }

  return <Outlet />;
}
