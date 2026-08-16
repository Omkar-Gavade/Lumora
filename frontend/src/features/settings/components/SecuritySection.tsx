import { useState } from 'react';
import { newPasswordSchema } from '@lumora/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { PasswordRequirements } from '@/features/auth/components/PasswordRequirements';
import { messageForError } from '@/constants/messages';
import { useAuth } from '@/app/providers/AuthProvider';
import { useChangePassword } from '../hooks/useAccount';

interface Errors {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

/**
 * Change password (FR-34, docs/04-data-and-api.md §2.2 — "requires current
 * password, revokes other sessions").
 */
export function SecuritySection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [done, setDone] = useState(false);

  const { signOut } = useAuth();
  const change = useChangePassword();

  function clearFields() {
    // Sensitive values leave React state as soon as they are no longer needed.
    // They were never written anywhere else — no localStorage, no logs, no
    // module variable — so this is the only copy to drop.
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  function handleSubmit(event: React.SyntheticEvent) {
    event.preventDefault();

    const next: Errors = {};
    if (currentPassword.length === 0) next.currentPassword = 'Enter your current password.';

    // Same schema the server validates with, so the form cannot claim a
    // password is acceptable and then be told otherwise by a 422.
    const parsed = newPasswordSchema.safeParse(newPassword);
    if (!parsed.success) {
      next.newPassword = parsed.error.issues[0]?.message ?? 'That password is not valid.';
    }

    if (newPassword !== confirmPassword) next.confirmPassword = 'Passwords do not match.';

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    change.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          clearFields();
          setDone(true);
        },
        /*
          Cleared on failure too. A wrong current password is the common case
          here, and leaving the new password sitting in a form the user is
          about to abandon keeps it in memory for no benefit.
        */
        onError: () => { setCurrentPassword(''); },
      },
    );
  }

  if (done) {
    /*
      The change revoked every session, including this one — the server bumps
      `token_version`, so the token that made this request is already dead.
      Staying on the page would leave the user clicking a UI whose next request
      401s. An explicit sign-out makes it a deliberate, explained transition.
    */
    return (
      <div className="space-y-4 px-5 py-4">
        <Alert tone="success">
          Password changed. For your security, every device has been signed out.
        </Alert>
        <Button onClick={() => void signOut()}>Sign in again</Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="space-y-4 px-5 py-4">
        <FormField label="Current password" error={errors.currentPassword}>
          <PasswordInput
            value={currentPassword}
            onChange={(event) => { setCurrentPassword(event.target.value); }}
            autoComplete="current-password"
          />
        </FormField>

        <FormField label="New password" error={errors.newPassword}>
          <PasswordInput
            value={newPassword}
            onChange={(event) => { setNewPassword(event.target.value); }}
            autoComplete="new-password"
          />
        </FormField>

        <PasswordRequirements value={newPassword} />

        <FormField label="Confirm new password" error={errors.confirmPassword}>
          <PasswordInput
            value={confirmPassword}
            onChange={(event) => { setConfirmPassword(event.target.value); }}
            autoComplete="new-password"
          />
        </FormField>

        {change.isError && <Alert tone="error">{messageForError(change.error)}</Alert>}
      </div>

      <div className="flex justify-end border-t border-line px-5 py-3">
        <Button type="submit" loading={change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}
