import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { AuthProvider } from '@/app/providers/AuthProvider';
import { QueryProvider } from '@/app/providers/QueryProvider';
import { ProtectedRoute } from '@/app/router/ProtectedRoute';
import { PublicOnlyRoute } from '@/app/router/PublicOnlyRoute';
import { ScrollBehavior } from '@/app/router/ScrollBehavior';
import { ROUTES } from '@/app/router/routes';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { MarketingLayout } from '@/components/layout/MarketingLayout';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { AppShellSkeleton } from '@/components/layout/AppShellSkeleton';
import { HomePage } from '@/pages/marketing/HomePage';

/**
 * The homepage is imported eagerly — it is the entry point for most visitors,
 * and lazy-loading it only adds a round trip before first paint.
 *
 * Everything else is split. A visitor who never signs in downloads no form
 * library, no validation schemas, and no legal-page content.
 */
const PrivacyPage = lazy(() =>
  import('@/pages/marketing/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() =>
  import('@/pages/marketing/TermsPage').then((m) => ({ default: m.TermsPage })),
);
const LoginPage = lazy(() =>
  import('@/pages/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const SignupPage = lazy(() =>
  import('@/pages/auth/SignupPage').then((m) => ({ default: m.SignupPage })),
);
const ForgotPasswordPage = lazy(() =>
  import('@/pages/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })),
);
const ResetPasswordPage = lazy(() =>
  import('@/pages/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
const VerifyEmailPage = lazy(() =>
  import('@/pages/auth/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage })),
);
const NotFoundPage = lazy(() =>
  import('@/pages/errors/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);
const ServerErrorPage = lazy(() =>
  import('@/pages/errors/ServerErrorPage').then((m) => ({ default: m.ServerErrorPage })),
);

/*
  The authenticated half.

  `AppLayout` is split from the pages it hosts: the shell is one chunk shared
  by every app route, so moving between Chat and Documents downloads only the
  page. A visitor who never signs in downloads none of it.
*/
const AppLayout = lazy(() =>
  import('@/components/layout/AppLayout').then((m) => ({ default: m.AppLayout })),
);
const ChatPage = lazy(() => import('@/pages/app/ChatPage').then((m) => ({ default: m.ChatPage })));
const KnowledgeBasePage = lazy(() =>
  import('@/pages/app/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })),
);
const DocumentsPage = lazy(() =>
  import('@/pages/app/DocumentsPage').then((m) => ({ default: m.DocumentsPage })),
);
const SearchPage = lazy(() =>
  import('@/pages/app/SearchPage').then((m) => ({ default: m.SearchPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/app/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AppNotFoundPage = lazy(() =>
  import('@/pages/errors/AppNotFoundPage').then((m) => ({ default: m.AppNotFoundPage })),
);

/**
 * Empty rather than a spinner. Route chunks resolve in well under 100ms on a
 * warm connection, and a spinner that flashes for 60ms reads as jank — the
 * absence of a flash is the better experience.
 */
const RouteFallback = <div className="min-h-dvh" />;

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <ScrollBehavior />
        {/* Inside the router: the guards it feeds use `useLocation`, and
            session restoration is what they wait on. */}
        <QueryProvider>
        <AuthProvider>
        <ErrorBoundary>
          <Suspense fallback={RouteFallback}>
            <Routes>
              <Route element={<MarketingLayout />}>
                <Route path={ROUTES.home} element={<HomePage />} />
                <Route path={ROUTES.privacy} element={<PrivacyPage />} />
                <Route path={ROUTES.terms} element={<TermsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>

              {/*
                `PublicOnlyRoute` bounces an already-signed-in user away from
                these screens (docs/02-frontend.md §4) — a stale "Sign in" link
                should not offer a login form for the account already in use.

                `verify-email` sits *outside* it, deliberately: the whole point
                of that screen is to be reachable while signed in but
                unverified, and it is also the landing page for the emailed
                link, which may be opened in a browser that already has a
                session.
              */}
              <Route element={<PublicOnlyRoute />}>
                <Route element={<AuthLayout />}>
                  <Route path={ROUTES.login} element={<LoginPage />} />
                  <Route path={ROUTES.signup} element={<SignupPage />} />
                  <Route path={ROUTES.forgotPassword} element={<ForgotPasswordPage />} />
                  <Route path={ROUTES.resetPassword} element={<ResetPasswordPage />} />
                </Route>
              </Route>

              <Route element={<AuthLayout />}>
                <Route path={ROUTES.verifyEmail} element={<VerifyEmailPage />} />
              </Route>

              {/*
                The application shell.

                `ProtectedRoute` wraps it — while the session resolves it
                renders the shell skeleton rather than redirecting, which is
                what prevents the flash-to-login-and-back on every reload.

                There is one guard, not two. The verification gate that used
                to wrap chat, knowledge, and documents is gone with its backend
                counterpart — signed in is the only question the router asks.

                The shell renders its own 404 rather than falling through to
                the marketing one: a signed-in user who mistypes a URL should
                keep their navigation, not be ejected to the public site.
              */}
              <Route
                path={ROUTES.app}
                element={
                  /*
                    A second boundary, with a fallback shaped like the shell it
                    is waiting for. The outer one renders nothing, which is
                    right for a marketing page arriving in 40ms and wrong here:
                    the shell chunk is the largest in the app, and an empty
                    viewport for a third of a second is the difference between
                    "loading" and "broken".
                  */
                  <ProtectedRoute />
                }
              >
                <Route
                  element={
                    <Suspense fallback={<AppShellSkeleton />}>
                      <AppLayout />
                    </Suspense>
                  }
                >
                  <Route index element={<Navigate to={ROUTES.chat} replace />} />

                  <Route path="chat" element={<ChatPage />} />
                  <Route path="chat/:conversationId" element={<ChatPage />} />
                  <Route path="knowledge" element={<KnowledgeBasePage />} />
                  <Route path="documents" element={<DocumentsPage />} />
                  <Route path="search" element={<SearchPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<AppNotFoundPage />} />
                </Route>
              </Route>

              <Route path={ROUTES.serverError} element={<ServerErrorPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
        </AuthProvider>
        </QueryProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
