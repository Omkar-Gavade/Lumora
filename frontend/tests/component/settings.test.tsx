import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { UserDto } from '@lumora/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileSection } from '@/features/settings/components/ProfileSection';
import { SecuritySection } from '@/features/settings/components/SecuritySection';
import { DangerSection } from '@/features/settings/components/DangerSection';
import { ApiError } from '@/lib/api/errors';
import * as usersApi from '@/features/settings/api/users.api';

/**
 * Settings behaviour (docs/00-product.md FR-34/36, §8.5).
 *
 * The API module is mocked rather than `fetch`: what these tests are about is
 * what the *component* does with a success or a failure — clearing a password
 * field, refusing a mistyped confirmation, returning focus — and going through
 * the transport would test the client twice and the component once.
 */

vi.mock('@/features/settings/api/users.api');

const signOut = vi.fn<() => Promise<void>>(() => Promise.resolve());
const refreshUser = vi.fn<() => Promise<void>>(() => Promise.resolve());

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({ signOut, refreshUser }),
  useAuthenticatedUser: () => USER,
}));

const USER: UserDto = {
  id: 'user-1',
  email: 'person@example.test',
  displayName: 'Original Name',
  emailVerified: true,
  createdAt: new Date().toISOString(),
};

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Profile', () => {
  it('shows the current user and saves a new display name', async () => {
    vi.mocked(usersApi.updateProfile).mockResolvedValue({ ...USER, displayName: 'New Name' });
    const user = userEvent.setup();
    wrap(<ProfileSection user={USER} />);

    const field = screen.getByLabelText(/display name/i);
    expect(field).toHaveValue('Original Name');

    await user.clear(field);
    await user.type(field, 'New Name');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(usersApi.updateProfile).toHaveBeenCalledWith('New Name');
    });
    expect(await screen.findByText(/profile updated/i)).toBeInTheDocument();
  });

  it('renders email as a disabled control', () => {
    /*
      FR-34 makes email read-only in Phase 1. Asserted as `disabled` rather
      than by appearance: a field that merely looks uneditable still submits
      its value, which is an account-takeover vector the day someone adds
      `email` to the request body.
    */
    wrap(<ProfileSection user={USER} />);
    expect(screen.getByLabelText(/email/i)).toBeDisabled();
  });

  it('keeps Save disabled until something changes', async () => {
    const user = userEvent.setup();
    wrap(<ProfileSection user={USER} />);

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/display name/i), '!');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('restores the original name on cancel', async () => {
    const user = userEvent.setup();
    wrap(<ProfileSection user={USER} />);

    await user.type(screen.getByLabelText(/display name/i), ' edited');
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getByLabelText(/display name/i)).toHaveValue('Original Name');
  });

  it('surfaces a server error without losing the input', async () => {
    vi.mocked(usersApi.updateProfile).mockRejectedValue(
      new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.', null),
    );
    const user = userEvent.setup();
    wrap(<ProfileSection user={USER} />);

    await user.type(screen.getByLabelText(/display name/i), ' edited');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toHaveValue('Original Name edited');
  });

  it('rejects a blank name before calling the API', async () => {
    const user = userEvent.setup();
    wrap(<ProfileSection user={USER} />);

    const field = screen.getByLabelText(/display name/i);
    await user.clear(field);
    await user.type(field, '   ');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(usersApi.updateProfile).not.toHaveBeenCalled();
  });
});

describe('Change password', () => {
  const STRONG = 'Replacement-Passphrase-9174';

  it('refuses to submit when the confirmation does not match', async () => {
    const user = userEvent.setup();
    wrap(<SecuritySection />);

    await user.type(screen.getByLabelText(/current password/i), 'old-password');
    await user.type(screen.getByLabelText(/^new password$/i), STRONG);
    await user.type(screen.getByLabelText(/confirm new password/i), `${STRONG}-typo`);
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(usersApi.changePassword).not.toHaveBeenCalled();
  });

  it('refuses a new password that fails the shared policy', async () => {
    // The same schema the server enforces, so the form cannot call something
    // acceptable and then be contradicted by a 422.
    const user = userEvent.setup();
    wrap(<SecuritySection />);

    await user.type(screen.getByLabelText(/current password/i), 'old-password');
    await user.type(screen.getByLabelText(/^new password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm new password/i), 'short');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(usersApi.changePassword).not.toHaveBeenCalled();
  });

  it('submits, clears every field, and offers a fresh sign-in', async () => {
    vi.mocked(usersApi.changePassword).mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<SecuritySection />);

    await user.type(screen.getByLabelText(/current password/i), 'old-password');
    await user.type(screen.getByLabelText(/^new password$/i), STRONG);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG);
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/every device has been signed out/i)).toBeInTheDocument();

    /*
      The form is gone, so the password fields are gone with it. That is the
      strongest available assertion that nothing sensitive is still mounted —
      the values were only ever in this component's state.
    */
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(signOut).toHaveBeenCalled();
  });

  it('clears the current-password field when the server rejects it', async () => {
    vi.mocked(usersApi.changePassword).mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'Your current password is incorrect.', null),
    );
    const user = userEvent.setup();
    wrap(<SecuritySection />);

    await user.type(screen.getByLabelText(/current password/i), 'wrong-password');
    await user.type(screen.getByLabelText(/^new password$/i), STRONG);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG);
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
  });
});

describe('Delete account', () => {
  it('is collapsed behind a deliberate opening step', () => {
    wrap(<DangerSection user={USER} />);

    expect(screen.getByRole('button', { name: /^delete account$/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('refuses a mistyped email without calling the API', async () => {
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    await user.click(screen.getByRole('button', { name: /^delete account$/i }));
    await user.type(screen.getByLabelText(/type your email/i), 'wrong@example.test');
    await user.type(screen.getByLabelText(/^password$/i), 'any-password');
    await user.click(screen.getByRole('button', { name: /delete my account/i }));

    expect(await screen.findByText(/does not match/i)).toBeInTheDocument();
    expect(usersApi.deleteAccount).not.toHaveBeenCalled();
  });

  it('requires the password even when the email matches', async () => {
    // Two independent gates: the email defeats reflex, the password defeats an
    // unattended session — and the email is visible on the same screen, so it
    // is no barrier at all to someone sitting at the machine.
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    await user.click(screen.getByRole('button', { name: /^delete account$/i }));
    await user.type(screen.getByLabelText(/type your email/i), USER.email);
    await user.click(screen.getByRole('button', { name: /delete my account/i }));

    expect(await screen.findByText(/enter your password/i)).toBeInTheDocument();
    expect(usersApi.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes and signs out when both gates are satisfied', async () => {
    vi.mocked(usersApi.deleteAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    await user.click(screen.getByRole('button', { name: /^delete account$/i }));
    await user.type(screen.getByLabelText(/type your email/i), USER.email);
    await user.type(screen.getByLabelText(/^password$/i), 'correct-password');
    await user.click(screen.getByRole('button', { name: /delete my account/i }));

    await waitFor(() => {
      expect(usersApi.deleteAccount).toHaveBeenCalledWith('correct-password');
    });
    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
  });

  it('clears the password and keeps the account when the server refuses', async () => {
    vi.mocked(usersApi.deleteAccount).mockRejectedValue(
      new ApiError(401, 'UNAUTHORIZED', 'That password is incorrect.', null),
    );
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    await user.click(screen.getByRole('button', { name: /^delete account$/i }));
    await user.type(screen.getByLabelText(/type your email/i), USER.email);
    await user.type(screen.getByLabelText(/^password$/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /delete my account/i }));

    /*
      Counted, not matched by text. The confirmation always renders a standing
      warning alert, so one alert is the resting state and two means the
      failure was surfaced — and `messageForError` maps the code to its own
      copy, so asserting the server's wording would test the wrong module.
    */
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(2);
    });
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('moves focus into the confirmation and returns it on cancel', async () => {
    /*
      Focus management is the accessibility requirement with teeth here. Opening
      the confirmation without moving focus leaves a keyboard user tabbing from
      the top of the page; cancelling without restoring it drops focus to
      document.body, so the next Tab restarts from the beginning.
    */
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    const opener = screen.getByRole('button', { name: /^delete account$/i });
    await user.click(opener);

    await waitFor(() => {
      expect(screen.getByLabelText(/type your email/i)).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^delete account$/i })).toHaveFocus();
    });
  });

  it('is fully operable from the keyboard', async () => {
    vi.mocked(usersApi.deleteAccount).mockResolvedValue(undefined);
    const user = userEvent.setup();
    wrap(<DangerSection user={USER} />);

    // Open with the keyboard rather than a click.
    await user.tab();
    expect(screen.getByRole('button', { name: /^delete account$/i })).toHaveFocus();
    await user.keyboard('{Enter}');

    // Focus lands in the first field, so typing works without reaching for a
    // pointer.
    await waitFor(() => {
      expect(screen.getByLabelText(/type your email/i)).toHaveFocus();
    });
    await user.keyboard(USER.email);
    await user.tab();
    await user.keyboard('correct-password');

    await user.click(screen.getByRole('button', { name: /delete my account/i }));
    await waitFor(() => {
      expect(usersApi.deleteAccount).toHaveBeenCalled();
    });
  });
});
