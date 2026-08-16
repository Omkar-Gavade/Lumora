import { useState } from 'react';
import type { UserDto } from '@lumora/shared';
import { displayNameSchema } from '@lumora/shared';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { messageForError } from '@/constants/messages';
import { useUpdateProfile } from '../hooks/useAccount';

/**
 * Profile (docs/00-product.md FR-34: "display name, email (read-only in
 * Phase 1), change password").
 */
export function ProfileSection({ user }: { user: UserDto }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  /*
    The last value known to be persisted, tracked separately from the `user`
    prop.

    Dirty-checking against the prop looks equivalent and is not: the prop only
    refreshes when the auth context round-trips, so between a successful save
    and that refresh the form still reads as unsaved — which hid the success
    message and re-enabled Save on a value that had just been written.
  */
  const [baseline, setBaseline] = useState(user.displayName);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const update = useUpdateProfile();

  const dirty = displayName.trim() !== baseline;

  function handleSubmit(event: React.SyntheticEvent) {
    event.preventDefault();

    /*
      Validated with the same schema the server uses, from `shared/`. A second
      hand-written rule here would drift, and the drift is only ever discovered
      as a 422 on a form that said it was valid.
    */
    const parsed = displayNameSchema.safeParse(displayName);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'That name is not valid.');
      return;
    }

    setFieldError(undefined);
    setSaved(false);
    update.mutate(parsed.data, {
      onSuccess: (updated) => {
        setBaseline(updated.displayName);
        setDisplayName(updated.displayName);
        setSaved(true);
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="space-y-4 px-5 py-4">
        <FormField label="Display name" error={fieldError}>
          <Input
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
            autoComplete="name"
          />
        </FormField>

        <FormField
          label="Email"
          hint="Email cannot be changed in this version."
        >
          {/*
            Genuinely disabled, not merely styled as read-only. A field that
            looks uneditable but posts its value is the kind of thing that
            becomes an account-takeover vector the moment someone adds
            `email` to the request body.
          */}
          <Input value={user.email} disabled readOnly autoComplete="email" />
        </FormField>

        <div className="flex items-center gap-2">
          <Badge variant={user.emailVerified ? 'success' : 'neutral'} size="sm">
            {user.emailVerified ? 'Verified' : 'Unverified'}
          </Badge>
        </div>

        {update.isError && (
          <Alert tone="error">{messageForError(update.error)}</Alert>
        )}
        {saved && !dirty && <Alert tone="success">Profile updated.</Alert>}
      </div>

      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button
          type="button"
          variant="secondary"
          disabled={!dirty || update.isPending}
          onClick={() => {
            setDisplayName(baseline);
            setFieldError(undefined);
            setSaved(false);
          }}
        >
          Cancel
        </Button>
        {/*
          Per-section save, per docs/00-product.md §8.5: "Saves are per-section,
          not one global save button, so the user always knows what was saved."
        */}
        <Button type="submit" disabled={!dirty} loading={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
