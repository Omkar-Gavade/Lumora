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
 * **The form renders immediately, including while the session is still
 * resolving.** It used to return `null` for that window, which was defensible
 * when the window was a few hundred milliseconds and wrong once it was not: on
 * a cold backend the bootstrap refresh can take half a minute, and for that
 * whole time /login was a blank page. The reported symptom was exactly that —
 * the login screen appearing only on a second visit, once the session had
 * already resolved and the guard stopped blocking.
 *
 * The asymmetry with `ProtectedRoute` is deliberate. That guard must wait,
 * because rendering app chrome for a user who turns out to be signed out is a
 * privacy question. This one has nothing to protect: the worst case is that an
 * already-signed-in user sees a login form for a moment before being
 * redirected, which is a cosmetic flash. Weigh that against a signed-out user
 * — the entire audience for this screen — staring at nothing.
 */
export function PublicOnlyRoute() {
  const { status } = useAuth();
  const [searchParams] = useSearchParams();

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
