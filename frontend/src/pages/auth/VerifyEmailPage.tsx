import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Mail, TriangleAlert } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useCooldown } from '@/hooks/useCooldown';
import { AuthCard } from '@/components/common/AuthCard';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { Spinner } from '@/components/ui/Spinner';
import { TextLink } from '@/components/ui/TextLink';
import { mockResendVerification, mockVerifyEmail } from '@/features/auth/api/mock-auth';

type Status = 'awaiting' | 'verifying' | 'verified' | 'expired';

/**
 * One route, two entry paths:
 *   from signup (`?email=`)  → "check your inbox", with resend
 *   from the email (`?token=`) → verifying → verified | expired
 *
 * Both live here because they are the same step in the user's head, and
 * splitting them across two routes would mean the resend action lands on a
 * different URL than the one the user was told to watch.
 */
export function VerifyEmailPage() {
  useDocumentTitle('Verify your email — Lumora');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const email = searchParams.get('email');

  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'awaiting');
  const { remaining, start } = useCooldown(60);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    void mockVerifyEmail(token).then((outcome) => {
      if (cancelled) return;
      setStatus(outcome === 'success' ? 'verified' : 'expired');
    });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const onResend = async () => {
    await mockResendVerification();
    start();
  };

  if (status === 'verifying') {
    return (
      <AuthCard title="Verifying your email" description="This takes a moment.">
        <div
          className="flex items-center justify-center rounded-lg border border-line bg-inset py-10"
          role="status"
        >
          <Spinner className="size-5 text-tertiary" />
          <span className="sr-only">Verifying</span>
        </div>
      </AuthCard>
    );
  }

  if (status === 'verified') {
    return (
      <AuthCard title="Email verified" description="Your account is ready.">
        <Alert tone="success">
          You can now upload documents and start asking questions.
        </Alert>
        <Button asChild variant="primary" size="lg" full className="mt-4">
          <Link to={ROUTES.login}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Continue
          </Link>
        </Button>
      </AuthCard>
    );
  }

  if (status === 'expired') {
    return (
      <AuthCard
        title="This link has expired"
        description="Verification links are valid for 24 hours."
      >
        <div className="rounded-lg border border-line bg-inset p-4">
          <TriangleAlert className="size-5 text-tertiary" aria-hidden="true" />
          <p className="mt-3 text-body-sm text-secondary text-pretty">
            Sign in and we&rsquo;ll send a fresh link to your inbox — your account and any
            documents you already uploaded are untouched.
          </p>
        </div>

        <Button asChild variant="primary" size="lg" full className="mt-4">
          <Link to={ROUTES.login}>Sign in to resend</Link>
        </Button>
      </AuthCard>
    );
  }

  // awaiting — arrived here straight from signup
  return (
    <AuthCard
      title="Check your inbox"
      description={
        email ? (
          <>
            We sent a verification link to <span className="text-primary">{email}</span>. It
            expires in 24 hours.
          </>
        ) : (
          'We sent you a verification link. It expires in 24 hours.'
        )
      }
      footer={
        <>
          Wrong address? <TextLink to={ROUTES.signup}>Sign up again</TextLink>
        </>
      }
    >
      <div className="rounded-lg border border-line bg-inset p-4">
        <Mail className="size-5 text-tertiary" aria-hidden="true" />
        <p className="mt-3 text-body-sm text-secondary text-pretty">
          You can sign in before verifying, but uploading documents and asking questions stay
          locked until your address is confirmed.
        </p>
      </div>

      <Button
        variant="secondary"
        size="lg"
        full
        className="mt-4"
        disabled={remaining > 0}
        onClick={() => void onResend()}
      >
        {remaining > 0 ? `Resend in ${remaining}s` : 'Resend verification email'}
      </Button>

      <Button asChild variant="ghost" size="lg" full className="mt-2">
        <Link to={ROUTES.login}>Back to sign in</Link>
      </Button>
    </AuthCard>
  );
}
