/**
 * Checks a password against a corpus of known-breached credentials.
 *
 * Behind an interface for two real reasons, not one imagined one: tests must
 * not make network calls, and the check must be switchable off entirely by
 * configuration. Both are implementations, so both belong here.
 */
export interface BreachChecker {
  readonly name: string;
  /**
   * `true` when the password is known to be breached.
   *
   * Implementations **must fail open** — returning `false` when the lookup
   * cannot be completed. An unreachable third party is not a reason a user
   * cannot create an account, and treating it as one converts someone else's
   * outage into ours.
   */
  isBreached(password: string): Promise<boolean>;
}
