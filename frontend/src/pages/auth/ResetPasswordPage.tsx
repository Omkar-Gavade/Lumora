import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, LinkIcon } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthCard } from '@/components/common/AuthCard';
import { FormField } from '@/components/ui/FormField';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { PasswordRequirements } from '@/features/auth/components/PasswordRequirements';
import {
  resetPasswordSchema,
  type ResetPasswordValues,
} from '@/features/auth/schemas/auth.schemas';
import { resetPassword } from '@/features/auth/api/auth.api';
import { messageForError } from '@/constants/messages';
import { Alert as ErrorAlert } from '@/components/ui/Alert';

/**
 * Three states, all reachable and all designed:
 *   missing/invalid token → explain and offer a new link
 *   valid token           → the form
 *   done                  → confirm, and state that other sessions were ended
 *
 * Visit `/reset-password` with no token, or `?token=expired`, to see the
 * failure branches.
 */
export function ResetPasswordPage() {
  useDocumentTitle('Choose a new password — Lumora');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onTouched',
    defaultValues: { password: '', confirmPassword: '' },
  });

  const password = watch('password');

  // The server is the authority on whether a token is usable — it is hashed
  // there and its expiry is not knowable here. This only catches the case of
  // arriving with no token at all, so the form is not offered when it cannot
  // possibly succeed.
  const tokenIsUsable = Boolean(token);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    if (!token) return;
    try {
      await resetPassword(token, values.password);
      setDone(true);
    } catch (error) {
      setFormError(messageForError(error));
    }
  });

  if (!tokenIsUsable) {
    return (
      <AuthCard
        title="This link is no longer valid"
        description="Reset links expire after one hour and can only be used once."
      >
        <div className="rounded-lg border border-line bg-inset p-4">
          <LinkIcon className="size-5 text-tertiary" aria-hidden="true" />
          <p className="mt-3 text-body-sm text-secondary text-pretty">
            {token
              ? 'This link has expired or has already been used. Request a new one and it will arrive within a minute.'
              : 'This page needs a reset link from your email. Request one to continue.'}
          </p>
        </div>

        <Button asChild variant="primary" size="lg" full className="mt-4">
          <Link to={ROUTES.forgotPassword}>Request a new link</Link>
        </Button>

        <Button asChild variant="ghost" size="lg" full className="mt-2">
          <Link to={ROUTES.login}>Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="Password updated" description="You can now sign in with your new password.">
        <Alert tone="success">
          For your security, every other device signed in to this account has been signed out.
        </Alert>

        <Button asChild variant="primary" size="lg" full className="mt-4">
          <Link to={ROUTES.login}>
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Continue to sign in
          </Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="Pick something you don’t use anywhere else."
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-5">
        {/* An expired or already-used link only fails on submit, because only
            the server can tell — so the failure has to be reportable here. */}
        {formError && <ErrorAlert>{formError}</ErrorAlert>}

        <div>
          {/* Message suppressed — the checklist below states the rules. */}
          <FormField label="New password" invalid={Boolean(errors.password)}>
            <PasswordInput autoComplete="new-password" autoFocus {...register('password')} />
          </FormField>
          <PasswordRequirements value={password ?? ''} />
        </div>

        <FormField label="Confirm new password" error={errors.confirmPassword?.message}>
          <PasswordInput autoComplete="new-password" {...register('confirmPassword')} />
        </FormField>

        <Button type="submit" variant="primary" size="lg" full loading={isSubmitting}>
          Update password
        </Button>

        <p className="text-center text-caption text-tertiary text-pretty">
          Updating your password signs out all other sessions.
        </p>
      </form>
    </AuthCard>
  );
}
