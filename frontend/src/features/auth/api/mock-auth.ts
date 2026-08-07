/**
 * Frontend-only stand-ins for the auth endpoints.
 *
 * These exist so every screen can be driven through its real loading, success,
 * and error states before a backend exists — states that get retrofitted badly
 * if the UI is only ever built against an instant happy path.
 *
 * Signatures match the planned API in docs/04-data-and-api.md §2.1, so wiring
 * the real client later replaces the body of each function and nothing else.
 */

const LATENCY_MS = 900;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MockAuthError';
  }
}

/** Typing this address triggers the failure path, so error states stay reachable. */
const FAILING_EMAIL = 'taken@lumora.app';

export async function mockLogin(email: string): Promise<void> {
  await wait(LATENCY_MS);
  if (email.trim().toLowerCase() === FAILING_EMAIL) {
    // Deliberately identical whether the account exists or the password is
    // wrong — distinguishing them enumerates accounts.
    throw new MockAuthError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
}

export async function mockSignup(email: string): Promise<void> {
  await wait(LATENCY_MS);
  if (email.trim().toLowerCase() === FAILING_EMAIL) {
    throw new MockAuthError('EMAIL_TAKEN', 'An account with that email already exists.');
  }
}

/** Always resolves — revealing whether an address is registered would leak it. */
export async function mockForgotPassword(): Promise<void> {
  await wait(LATENCY_MS);
}

export async function mockResetPassword(): Promise<void> {
  await wait(LATENCY_MS);
}

export async function mockResendVerification(): Promise<void> {
  await wait(LATENCY_MS);
}

export type VerificationOutcome = 'success' | 'expired';

export async function mockVerifyEmail(token: string): Promise<VerificationOutcome> {
  await wait(1200);
  return token === 'expired' ? 'expired' : 'success';
}
