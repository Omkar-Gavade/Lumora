import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ROUTES } from '@/app/router/routes';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthCard } from '@/components/common/AuthCard';
import { FormField } from '@/components/ui/FormField';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { TextLink } from '@/components/ui/TextLink';
import { PasswordRequirements } from '@/features/auth/components/PasswordRequirements';
import { signupSchema, type SignupValues } from '@/features/auth/schemas/auth.schemas';
import { signup } from '@/features/auth/api/auth.api';
import { useAuth } from '@/app/providers/AuthProvider';
import { messageForError } from '@/constants/messages';

export function SignupPage() {
  useDocumentTitle('Create your account — Lumora');
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const { adoptSession } = useAuth();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
      acceptTerms: false as unknown as true,
    },
  });

  const password = watch('password');
  const email = watch('email');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await signup({
        displayName: values.name,
        email: values.email,
        password: values.password,
      });
      // FR-5: signup issues a real session immediately. The account is usable —
      // only uploads and chat wait on verification.
      adoptSession(session);
      // Carry the address forward so the next screen can show where the
      // verification email went — a typo is otherwise invisible.
      void navigate(`${ROUTES.verifyEmail}?email=${encodeURIComponent(values.email)}`);
    } catch (error) {
      setFormError(messageForError(error));
    }
  });

  return (
    <AuthCard
      title="Create your account"
      description="Upload documents and start asking questions in about a minute."
      footer={
        <>
          Already have an account? <TextLink to={ROUTES.login}>Sign in</TextLink>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-5">
        {formError && <Alert>{formError}</Alert>}

        <FormField label="Name" error={errors.name?.message}>
          <Input autoComplete="name" placeholder="Ada Lovelace" autoFocus {...register('name')} />
        </FormField>

        <FormField label="Email" error={errors.email?.message}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            {...register('email')}
          />
        </FormField>

        {/* Invalid state only, no message: the checklist below already states
            every requirement, so an error line would repeat it word for word. */}
        <div>
          <FormField label="Password" invalid={Boolean(errors.password)}>
            <PasswordInput autoComplete="new-password" {...register('password')} />
          </FormField>
          <PasswordRequirements value={password ?? ''} />
        </div>

        <FormField label="Confirm password" error={errors.confirmPassword?.message}>
          <PasswordInput autoComplete="new-password" {...register('confirmPassword')} />
        </FormField>

        <div>
          <label className="flex cursor-pointer items-start gap-2.5 text-body-sm text-secondary">
            <span className="mt-0.5">
              <Checkbox {...register('acceptTerms')} />
            </span>
            <span className="text-pretty">
              I agree to the <TextLink to={ROUTES.terms}>Terms of Service</TextLink> and{' '}
              <TextLink to={ROUTES.privacy}>Privacy Policy</TextLink>.
            </span>
          </label>
          {errors.acceptTerms?.message && (
            <FieldError className="mt-2">{errors.acceptTerms.message}</FieldError>
          )}
        </div>

        <Button type="submit" variant="primary" size="lg" full loading={isSubmitting}>
          Create account
        </Button>

        <p className="text-center text-caption text-tertiary">
          We&rsquo;ll send a verification link to{' '}
          {email ? <span className="text-secondary">{email}</span> : 'your email'}.
        </p>
      </form>
    </AuthCard>
  );
}
