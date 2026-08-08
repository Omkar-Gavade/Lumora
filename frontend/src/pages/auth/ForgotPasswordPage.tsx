import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useCooldown } from '@/hooks/useCooldown';
import { AuthCard } from '@/components/common/AuthCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { TextLink } from '@/components/ui/TextLink';
import {
  forgotPasswordSchema,
  type ForgotPasswordValues,
} from '@/features/auth/schemas/auth.schemas';
import { forgotPassword } from '@/features/auth/api/auth.api';

export function ForgotPasswordPage() {
  useDocumentTitle('Reset your password — Lumora');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { remaining, start } = useCooldown(60);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    mode: 'onTouched',
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    /*
      Always reports success, whether or not the account exists — and that
      includes when the request itself fails. The endpoint answers 200 for any
      valid address by design; surfacing a client-side error here would
      reintroduce the enumeration signal the endpoint was built to remove, and
      a rate-limit rejection would silently confirm the address had been tried
      before.
    */
    try {
      await forgotPassword(values.email);
    } catch {
      // Deliberately swallowed; see above.
    }
    setSentTo(values.email);
    start();
  });

  const onResend = async () => {
    try {
      await forgotPassword(getValues('email'));
    } catch {
      // Same reasoning as the initial submit.
    }
    start();
  };

  if (sentTo) {
    return (
      <AuthCard
        title="Check your inbox"
        description={
          <>
            If an account exists for <span className="text-primary">{sentTo}</span>, we&rsquo;ve
            sent a link to reset your password. It expires in one hour.
          </>
        }
      >
        <div className="rounded-lg border border-line bg-inset p-4">
          <MailCheck className="size-5 text-tertiary" aria-hidden="true" />
          <p className="mt-3 text-body-sm text-secondary text-pretty">
            Nothing arrived? Check your spam folder, and confirm the address above is the one
            you registered with.
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
          {remaining > 0 ? `Resend in ${remaining}s` : 'Resend email'}
        </Button>

        <Link
          to={ROUTES.login}
          className="mt-6 inline-flex w-full items-center justify-center gap-1.5 rounded-xs text-body-sm text-secondary transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email you signed up with and we’ll send you a reset link."
      footer={
        <>
          Remembered it? <TextLink to={ROUTES.login}>Back to sign in</TextLink>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-5">
        <FormField label="Email" error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            autoFocus
            defaultValue={getValues('email')}
            {...register('email')}
          />
        </FormField>

        <Button type="submit" variant="primary" size="lg" full loading={isSubmitting}>
          Send reset link
        </Button>
      </form>
    </AuthCard>
  );
}
