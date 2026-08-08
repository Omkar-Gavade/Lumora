import argon2 from 'argon2';
import {
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
} from '../../config/index.js';
import { PasswordBreachedError } from '../../domain/errors/index.js';
import { logger } from '../../lib/logger.js';
import { breachChecker } from '../../providers/breach/breach.factory.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

/**
 * A hash of a value no user will ever supply, verified against when an account
 * does not exist.
 *
 * **This is the entire timing-attack defense for login** (docs/04-data-and-api.md
 * §3.3). Argon2id at these parameters takes ~50ms; a lookup that misses takes
 * under a millisecond. Returning early on "no such user" therefore makes
 * non-existent accounts answer ~50× faster than real ones, and that gap is a
 * reliable account-enumeration oracle over the network — no error message
 * required.
 *
 * Computed once at module load rather than per request, because doing the work
 * twice would be pure latency.
 */
const dummyHashPromise: Promise<string> = argon2.hash(
  'lumora-timing-equalizer-not-a-real-password',
  ARGON2_OPTIONS,
);

/**
 * Password hashing and policy.
 *
 * No Express, no SQL — plain arguments in, plain values or a typed `AppError`
 * out (docs/03-backend.md §1), so every rule here is unit-testable without a
 * server or a database.
 */
export const passwordService = {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  },

  /**
   * Verifies a password against a stored hash.
   *
   * A malformed or truncated hash makes `argon2.verify` throw. That is caught
   * and reported as "does not match" rather than propagating: a corrupt row
   * must not become a 500 that tells an attacker this account's record is
   * unusual.
   */
  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch (error) {
      logger.error({ err: error }, 'Password verification failed against a stored hash');
      return false;
    }
  },

  /**
   * Burns the same time a real verification would, for a user that does not
   * exist. Called by the login flow on the miss path.
   */
  async verifyDummy(password: string): Promise<void> {
    await argon2.verify(await dummyHashPromise, password).catch(() => false);
  },

  /**
   * Rejects passwords found in public breach corpora.
   *
   * Applied when a password is *set* — signup and reset — never at sign-in. A
   * user whose existing password later appears in a breach must still be able
   * to log in and change it; locking them out of the account they need to fix
   * is the opposite of the intent.
   */
  async assertNotBreached(password: string): Promise<void> {
    if (await breachChecker.isBreached(password)) {
      throw new PasswordBreachedError();
    }
  },
};
