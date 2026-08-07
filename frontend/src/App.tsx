import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@/app/providers/ThemeProvider';
import { ScrollBehavior } from '@/app/router/ScrollBehavior';
import { ROUTES } from '@/app/router/routes';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { MarketingLayout } from '@/components/layout/MarketingLayout';
import { AuthLayout } from '@/components/layout/AuthLayout';
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
        <ErrorBoundary>
          <Suspense fallback={RouteFallback}>
            <Routes>
              <Route element={<MarketingLayout />}>
                <Route path={ROUTES.home} element={<HomePage />} />
                <Route path={ROUTES.privacy} element={<PrivacyPage />} />
                <Route path={ROUTES.terms} element={<TermsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>

              <Route element={<AuthLayout />}>
                <Route path={ROUTES.login} element={<LoginPage />} />
                <Route path={ROUTES.signup} element={<SignupPage />} />
                <Route path={ROUTES.forgotPassword} element={<ForgotPasswordPage />} />
                <Route path={ROUTES.resetPassword} element={<ResetPasswordPage />} />
                <Route path={ROUTES.verifyEmail} element={<VerifyEmailPage />} />
              </Route>
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </ThemeProvider>
  );
}
