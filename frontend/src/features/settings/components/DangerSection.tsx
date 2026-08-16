import { useEffect, useRef, useState } from 'react';
import type { UserDto } from '@lumora/shared';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { messageForError } from '@/constants/messages';
import { useAuth } from '@/app/providers/AuthProvider';
import { useDeleteAccount } from '../hooks/useAccount';

/**
 * Danger zone (docs/00-product.md §8.5: "visually separated with destructive
 * styling and requires typing the account email to confirm deletion";
 * FR-36: deletion "cascades to all documents, vectors, conversations").
 *
 * Two independent gates, and both are deliberate. Typing the email defeats
 * momentum — it is impossible to do by reflex — while the password defeats an
 * unattended session, which typing an address visible on the same screen does
 * not. Either alone leaves a real path to an accidental or malicious deletion.
 */
export function DangerSection({ user }: { user: UserDto }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();

  const { signOut } = useAuth();
  const remove = useDeleteAccount();

  const emailRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  /*
    Focus follows the disclosure in both directions.

    Restoring focus cannot happen inside `close()`: the opener button is not
    mounted while the confirmation is open, so its ref is stale at that moment
    and the focus call lands on a detached node. It has to run *after* the
    collapsed view has rendered, which is what this effect is for.

    `hasOpened` keeps the first mount from stealing focus to the delete button
    on a page the user has only just navigated to.
  */
  const hasOpened = useRef(false);

  useEffect(() => {
    if (open) {
      hasOpened.current = true;
      emailRef.current?.focus();
      return;
    }
    if (hasOpened.current) openerRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setEmail('');
    setPassword('');
    setError(undefined);
  }

  function handleSubmit(event: React.SyntheticEvent) {
    event.preventDefault();

    if (email.trim().toLowerCase() !== user.email.toLowerCase()) {
      setError('That does not match your account email.');
      return;
    }
    if (password.length === 0) {
      setError('Enter your password to confirm.');
      return;
    }

    setError(undefined);
    remove.mutate(password, {
      onSuccess: () => {
        /*
          `signOut` rather than a bare redirect. The account is gone, but this
          tab still holds an access token in memory and a stale query cache;
          signing out clears both and lands on the public route through the
          same path every other sign-out uses.
        */
        void signOut();
      },
      onError: () => { setPassword(''); },
    });
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-body-sm text-primary">Delete this account</p>
          <p className="text-body-sm text-secondary">
            Your documents, conversations, and search index are removed permanently.
            This cannot be undone.
          </p>
        </div>
        <Button
          ref={openerRef}
          variant="danger"
          className="shrink-0"
          onClick={() => { setOpen(true); }}
        >
          Delete account
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Confirm account deletion">
      <div className="space-y-4 px-5 py-4">
        <Alert tone="error">
          This permanently deletes your account, every document you have uploaded,
          and every conversation. It cannot be undone.
        </Alert>

        <FormField
          label="Type your email to confirm"
          hint={user.email}
        >
          <Input
            ref={emailRef}
            value={email}
            onChange={(event) => { setEmail(event.target.value); }}
            autoComplete="off"
          />
        </FormField>

        <FormField label="Password">
          <PasswordInput
            value={password}
            onChange={(event) => { setPassword(event.target.value); }}
            autoComplete="current-password"
          />
        </FormField>

        {error !== undefined && <Alert tone="error">{error}</Alert>}
        {remove.isError && <Alert tone="error">{messageForError(remove.error)}</Alert>}
      </div>

      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button type="button" variant="secondary" onClick={close} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" loading={remove.isPending}>
          Delete my account
        </Button>
      </div>
    </form>
  );
}
