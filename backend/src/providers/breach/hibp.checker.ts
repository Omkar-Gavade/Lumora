import { createHash } from 'node:crypto';
import { BREACH_CHECK_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import type { BreachChecker } from './breach-checker.interface.js';

const RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';

/**
 * Have I Been Pwned's Pwned Passwords, queried by k-anonymity
 * (docs/04-data-and-api.md §3.3).
 *
 * **The password never leaves this process, and neither does its full hash.**
 * The mechanism: SHA-1 the password, send only the first five hex characters,
 * and receive every suffix sharing that prefix — roughly 800 hashes. The match
 * is performed locally. HIBP learns that someone asked about a bucket
 * containing ~800 candidate passwords, which tells them nothing about which.
 *
 * SHA-1 here is not a security decision and is not a weakness: it is the
 * bucket addressing scheme the API defines. The password's *storage* hash is
 * Argon2id, computed separately and never sent anywhere.
 */
export class HibpBreachChecker implements BreachChecker {
  readonly name = 'hibp';

  async isBreached(password: string): Promise<boolean> {
    const digest = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    try {
      const response = await fetch(`${RANGE_ENDPOINT}/${prefix}`, {
        headers: {
          // Asks HIBP to pad the response with random entries, so an observer
          // cannot infer the bucket from the response size.
          'Add-Padding': 'true',
          'User-Agent': 'Lumora',
        },
        signal: AbortSignal.timeout(BREACH_CHECK_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Breach check returned a non-OK status');
        return false;
      }

      const body = await response.text();

      /*
        Lines are `SUFFIX:COUNT`. Padded entries have a count of 0 and must be
        ignored — treating them as hits would reject a large fraction of
        perfectly good passwords at random, which is the kind of bug that gets
        blamed on the password rules for weeks.
      */
      for (const line of body.split('\n')) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;

        if (line.slice(0, separator).trim() !== suffix) continue;

        const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
        return Number.isFinite(count) && count > 0;
      }

      return false;
    } catch (error) {
      // Fail open. The password is unverified, not rejected — see the interface.
      logger.warn({ err: error }, 'Breach check unavailable; allowing the password');
      return false;
    }
  }
}

/** Used when the check is disabled, and in tests. Never calls out. */
export class NoopBreachChecker implements BreachChecker {
  readonly name = 'noop';

  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
