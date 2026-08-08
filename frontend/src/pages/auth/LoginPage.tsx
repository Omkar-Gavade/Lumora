import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ROUTES } from '@/app/router/routes';
import { safeNextPath } from '@/app/router/safe-next';
import { useAuth } from '@/app/providers/AuthProvider';
import { messageForError } from '@/constants/messages';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthCard } from '@/components/common/AuthCard';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { TextLink } from '@/components/ui/TextLink';
import { loginSchema, type LoginValues } from '@/features/auth/schemas/auth.schemas';
import { login } from '@/features/auth/api/auth.api';

export function LoginPage() {
  useDocumentTitle('Sign in — Lumora');
  const [formError, setFormError] = useState<string | null>(null);
  const { adoptSession } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    // Validate on blur, then keep correcting live once a field has errored.
    // Validating on every keystroke from the start scolds the user mid-word.
    mode: 'onTouched',
    defaultValues: { email: '', password: '', remember: true },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await login({
        email: values.email,
        password: values.password,
        remember: values.remember,
      });
      adoptSession(session);
      // Return the user where they were sent from, sanitized — `next` comes
      // from the URL and an unchecked value is an open redirect.
      void navigate(safeNextPath(searchParams.get('next'), ROUTES.chat), { replace: true });
    } catch (error) {
      setFormError(messageForError(error));
    }
  });

  return (
    <AuthCard
      title="Sign in"
      description="Continue to your knowledge base."
      footer={
        <>
          Don&rsquo;t have an account? <TextLink to={ROUTES.signup}>Create one</TextLink>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-5">
        {formError && <Alert>{formError}</Alert>}

        <FormField label="Email" error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            autoFocus
            {...register('email')}
          />
        </FormField>

        <FormField
          label="Password"
          error={errors.password?.message}
          labelAction={
            <TextLink to={ROUTES.forgotPassword} className="text-caption">
              Forgot password?
            </TextLink>
          }
        >
          <PasswordInput autoComplete="current-password" {...register('password')} />
        </FormField>

        <label className="flex cursor-pointer items-center gap-2.5 text-body-sm text-secondary">
          <Checkbox {...register('remember')} />
          Keep me signed in
        </label>

        <Button type="submit" variant="primary" size="lg" full loading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
