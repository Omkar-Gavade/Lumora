import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { useCooldown } from '@/hooks/useCooldown';
import { resendVerification } from '@/features/auth/api/auth.api';
import { PageContainer } from '@/components/layout/PageContainer';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';

/**
 * Gates a route on a verified email address (FR-5).
 *
 * **Renders a prompt in place; it does not redirect.** FR-5 is explicit that
 * unverified users get a "read-only shell + verification prompt" — hard-blocking
 * sign-in strands anyone who loses the email, while soft-blocking the expensive
 * actions is what stops abuse of embedding spend. Sitting inside `AppLayout`
 * (docs/02-frontend.md §4) means the sidebar, header, and Settings stay
 * reachable, so the user can change their password or sign out.
 *
 * Nothing here re-reads verification state on an interval. Verification
 * reissues tokens with `emailVerified: true` (docs/04-data-and-api.md §3.3),
 * so clicking the link updates the claim and this gate lifts on the next
 * render rather than after a poll.
 */
export function VerifiedRoute() {
  const { user } = useAuth();
  const { remaining, start } = useCooldown(60);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (user?.emailVerified) return <Outlet />;

  const onResend = async () => {
    setSending(true);
    setError(null);
    try {
      await resendVerification();
      setSent(true);
      start();
    } catch {
      setError('Could not send the email just now. Please try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <PageContainer title="Verify your email" bare>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-md">
          <EmptyState
            icon={MailCheck}
            titleAs="h1"
            title="Verify your email to continue"
            description={
              user ? (
                <>
                  We sent a link to <span className="text-primary">{user.email}</span>. Confirm your
                  address to upload documents and start asking questions.
                </>
              ) : (
                'Confirm your address to upload documents and start asking questions.'
              )
            }
            action={
              <Button
                variant="primary"
                size="lg"
                loading={sending}
                disabled={remaining > 0}
                onClick={() => void onResend()}
              >
                {remaining > 0 ? `Resend in ${String(remaining)}s` : 'Resend verification email'}
              </Button>
            }
          />

          {sent && !error && (
            <Alert tone="success" className="mt-2">
              Sent. Check your inbox — the link expires in 24 hours.
            </Alert>
          )}
          {error && <Alert className="mt-2">{error}</Alert>}
        </div>
      </div>
    </PageContainer>
  );
}
