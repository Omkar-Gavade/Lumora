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
import { resendVerification, verifyEmail } from '@/features/auth/api/auth.api';
import { useAuth } from '@/app/providers/AuthProvider';

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

  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'awaiting');
  const { remaining, start } = useCooldown(60);
  const { adoptSession, user } = useAuth();

  /*
    The address comes from the session, falling back to the query parameter.

    Signup now issues a real session, so the signed-in user *is* the source of
    truth — and reading it here means the screen shows the right address even
    when it was reached by a redirect that carried no `?email=`. The parameter
    is kept as a fallback for the one case with no session: arriving from the
    emailed link in a different browser.
  */
  const email = user?.email ?? searchParams.get('email');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    void (async () => {
      try {
        const session = await verifyEmail(token);
        if (cancelled) return;
        /*
          Adopting the returned session is what makes the gate lift instantly.
          Verification reissues tokens carrying `emailVerified: true`
          (docs/04-data-and-api.md §3.3); without this the user would sit
          behind the verification prompt until their old access token expired,
          which reads as the link not having worked.
        */
        adoptSession(session);
        setStatus('verified');
      } catch {
        if (cancelled) return;
        /*
          The server does not distinguish expired from already-consumed from
          unknown — deliberately, since telling the holder of a stolen link
          which it is helps only them. But the *client* can tell one case
          apart safely: if the signed-in user is already verified, the link
          simply did its job earlier (docs/00-product.md §8 asks for this
          branch by name). No disclosure, because the session is proof.
        */
        setStatus(user?.emailVerified ? 'verified' : 'expired');
      }
    })();

    return () => {
      cancelled = true;
    };
    // `user` is read only inside the catch, to classify a failure. Including it
    // would re-run verification every time the session object changes — which
    // adopting a session does, immediately after this succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, adoptSession]);

  const onResend = async () => {
    try {
      await resendVerification();
    } catch {
      // The cooldown still starts: a failed resend that leaves the button
      // live invites the rapid re-clicking the cooldown exists to prevent.
    }
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
        {/* Straight into the app, not back to sign-in: verification returned a
            live session, so asking for credentials again would be asking the
            user to re-authenticate as themselves. */}
        <Button asChild variant="primary" size="lg" full className="mt-4">
          <Link to={ROUTES.chat}>
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
