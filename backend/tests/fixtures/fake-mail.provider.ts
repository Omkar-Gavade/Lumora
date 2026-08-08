import type {
  MailMessage,
  MailProvider,
  MailProviderHealth,
} from '../../src/providers/mail/mail-provider.interface.js';

/**
 * An in-memory `MailProvider` (docs/03-backend.md §9: "Providers are always
 * faked in tests").
 *
 * This is what makes the auth suite deterministic *and* honest. Tests pull the
 * verification token out of the delivered message body — the same path a real
 * user takes — rather than reaching into `verification_tokens`. Reading the
 * database would pass even if the email were never rendered, never addressed,
 * or missing its link entirely.
 *
 * It implements the same interface the SMTP driver does, so a change to that
 * contract breaks compilation here rather than being discovered when the fake
 * silently diverges from the real thing.
 */
export class FakeMailProvider implements MailProvider {
  readonly name = 'fake';

  /** Everything sent since the last `clear()`, oldest first. */
  readonly outbox: MailMessage[] = [];

  /** When set, `send` rejects with it. Used to test delivery failure paths. */
  failure: Error | null = null;

  /** When false, `verify()` reports unhealthy — for the startup-degradation test. */
  healthy = true;

  send(message: MailMessage): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.outbox.push(message);
    return Promise.resolve();
  }

  verify(): Promise<MailProviderHealth> {
    return this.healthy
      ? Promise.resolve({ ok: true, latencyMs: 0 })
      : Promise.resolve({ ok: false, latencyMs: 0, message: 'fake provider is marked unhealthy' });
  }

  clear(): void {
    this.outbox.length = 0;
    this.failure = null;
    this.healthy = true;
  }

  /** The most recent message sent to an address, or `undefined`. */
  lastTo(email: string): MailMessage | undefined {
    return [...this.outbox].reverse().find((message) => message.to === email);
  }

  /** Every message sent to an address, oldest first. */
  allTo(email: string): MailMessage[] {
    return this.outbox.filter((message) => message.to === email);
  }
}

/**
 * One shared instance.
 *
 * The production `mailProvider` is a module-level singleton, so the module
 * mock that replaces it has to hand back a stable object — a factory returning
 * a new fake per import would give each importer a different outbox, and
 * assertions would read an empty one.
 */
export const fakeMailProvider = new FakeMailProvider();
