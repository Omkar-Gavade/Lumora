import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ROUTES } from '@/app/router/routes';
import { useAuth } from '@/app/providers/AuthProvider';
import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';

/**
 * Requires a session (docs/02-frontend.md §4).
 *
 * **While the session is resolving it renders the shell skeleton — it does not
 * redirect.** Redirecting during resolution causes the flash-to-login-and-back
 * that the doc calls out by name: a reload would bounce a signed-in user to
 * /login for a few hundred milliseconds before the silent refresh completes.
 *
 * On failure the current location is carried in `?next=`, so signing in
 * returns the user exactly where they were rather than dumping them on a
 * default page.
 */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AppShellSkeleton />;

  if (status === 'unauthenticated') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`${ROUTES.login}?next=${encodeURIComponent(next)}`} replace />;
  }

  return <Outlet />;
}
