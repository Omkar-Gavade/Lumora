import { randomUUID } from 'node:crypto';
import type { AuthSessionDto } from '@lumora/shared';
import { API_PREFIX, request } from '../helpers/app.js';
import { verificationTokenFor } from '../helpers/mail.js';
import { db } from '../helpers/database.js';

/**
 * A password that satisfies the production policy — 12+ characters, mixed
 * case, a digit — and is not in any breach corpus.
 *
 * Shared by every factory so a policy change breaks one constant rather than
 * forty test files.
 */
export const TEST_PASSWORD = 'Zt7qLmVx4Kdw';

/**
 * A unique address per call.
 *
 * Not a fixed `test@example.com`: the login limiter is keyed on IP+email, so a
 * shared address would make the sixth test in a file fail on a limit the fifth
 * consumed. A uuid segment also makes a failing assertion say which test's
 * user it was looking at.
 */
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
  /** The session signup returned — access token and user DTO. */
  session: AuthSessionDto;
  /** Raw refresh token from the Set-Cookie, for rotation and replay tests. */
  refreshToken: string;
}

export interface CreateUserOptions {
  email?: string;
  password?: string;
  displayName?: string;
}

/**
 * Creates an account **through the public API**, unverified.
 *
 * Deliberately not a direct row insert. Going through `POST /auth/signup`
 * means every user a test works with was produced by the same code path a real
 * one is — correctly hashed, with a real verification token issued and a real
 * email delivered to the fake outbox. A factory that inserts rows fabricates
 * users the application could never have created, and tests built on it keep
 * passing after the signup flow breaks.
 */
export async function createTestUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const email = options.email ?? uniqueEmail();
  const password = options.password ?? TEST_PASSWORD;
  const displayName = options.displayName ?? 'Test User';

  const response = await request()
    .post(`${API_PREFIX}/auth/signup`)
    .send({ email, password, displayName });

  if (response.status !== 201) {
    throw new Error(
      `createTestUser: signup returned ${String(response.status)} — ${JSON.stringify(response.body)}`,
    );
  }

  const session = response.body as AuthSessionDto;
  const setCookie = response.headers['set-cookie'];
  const cookies: string[] = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  const refreshEntry = cookies.find((cookie) => cookie.startsWith('lumora_rt='));

  return {
    id: session.user.id,
    email,
    displayName,
    password,
    session,
    refreshToken: refreshEntry?.split(';')[0]?.split('=')[1] ?? '',
  };
}

/**
 * Creates an account and completes verification, returning the **reissued**
 * session.
 *
 * Verification mints fresh tokens carrying `emailVerified: true`
 * (docs/04-data-and-api.md §3.3), so the session returned here is the one that
 * passes `requireVerified`. Returning the pre-verification session instead
 * would give every caller a token that fails the gate, and the resulting test
 * failures would look like a bug in the gate.
 */
export async function createVerifiedUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const user = await createTestUser(options);
  const token = verificationTokenFor(user.email);

  const response = await request().post(`${API_PREFIX}/auth/verify-email`).send({ token });

  if (response.status !== 200) {
    throw new Error(
      `createVerifiedUser: verify-email returned ${String(response.status)} — ${JSON.stringify(response.body)}`,
    );
  }

  const session = response.body as AuthSessionDto;
  const setCookie = response.headers['set-cookie'];
  const cookies: string[] = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  const refreshEntry = cookies.find((cookie) => cookie.startsWith('lumora_rt='));

  return {
    ...user,
    session,
    refreshToken: refreshEntry?.split(';')[0]?.split('=')[1] ?? user.refreshToken,
  };
}

/**
 * Signs in an existing user and returns the new session.
 *
 * Separate from `createTestUser` because several tests need a *second*
 * session for the same account — sign-out-everywhere, family isolation — and
 * creating another user would not exercise either.
 */
export async function loginTestUser(
  email: string,
  password = TEST_PASSWORD,
  remember = true,
): Promise<{ session: AuthSessionDto; refreshToken: string }> {
  const response = await request()
    .post(`${API_PREFIX}/auth/login`)
    .send({ email, password, remember });

  if (response.status !== 200) {
    throw new Error(
      `loginTestUser: login returned ${String(response.status)} — ${JSON.stringify(response.body)}`,
    );
  }

  const setCookie = response.headers['set-cookie'];
  const cookies: string[] = Array.isArray(setCookie) ? setCookie : typeof setCookie === 'string' ? [setCookie] : [];
  const refreshEntry = cookies.find((cookie) => cookie.startsWith('lumora_rt='));

  return {
    session: response.body as AuthSessionDto,
    refreshToken: refreshEntry?.split(';')[0]?.split('=')[1] ?? '',
  };
}

/**
 * Reads the stored lockout counters.
 *
 * The only factory that touches the database directly, because the state it
 * asserts on is deliberately not exposed by any endpoint — surfacing "this
 * account is locked" to an unauthenticated caller is the enumeration oracle
 * docs/04-data-and-api.md §3.3 is built to avoid.
 */
export async function readLockoutState(
  userId: string,
): Promise<{ failedLoginCount: number; lockedUntil: Date | null }> {
  const row = await db
    .selectFrom('users')
    .select(['failed_login_count', 'locked_until'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

  return { failedLoginCount: row.failed_login_count, lockedUntil: row.locked_until };
}

/** Forces an account into a locked state, so lockout can be tested without
 *  spending five requests against the login limiter. */
export async function lockAccount(userId: string, forSeconds = 300): Promise<void> {
  await db
    .updateTable('users')
    .set({
      failed_login_count: 6,
      locked_until: new Date(Date.now() + forSeconds * 1000).toISOString(),
    })
    .where('id', '=', userId)
    .execute();
}
