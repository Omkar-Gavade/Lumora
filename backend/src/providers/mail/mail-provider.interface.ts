/**
 * One outbound message. Both a text and an HTML body, always.
 *
 * Text is not a fallback nicety: a message with no text part scores as spam
 * with most filters, and a verification link that lands in spam is an
 * activation funnel that silently ends. It is also what plain-text clients,
 * screen readers in text mode, and watch notifications actually render.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The result of asking a provider whether it can deliver.
 *
 * Deliberately the same shape as `checkDatabaseHealth` — `{ ok, latencyMs,
 * message? }` — so startup reporting and any future readiness surface treat
 * every dependency identically instead of learning a second vocabulary.
 */
export interface MailProviderHealth {
  ok: boolean;
  latencyMs: number;
  /** Present only on failure. Safe, generic; the real cause goes to the log. */
  message?: string;
}

/**
 * Delivery, behind an interface (docs/03-backend.md §1: providers know nothing
 * about Lumora's domain).
 *
 * The interface takes a rendered message, not a "send verification email"
 * method. A provider that knows what a verification email is cannot be swapped
 * without moving the templates too, and the templates are domain, not
 * transport. That is what makes Resend, SES, or Mailgun one new file and one
 * `switch` arm rather than a refactor.
 */
export interface MailProvider {
  /** Provider name, for logs. */
  readonly name: string;

  send(message: MailMessage): Promise<void>;

  /**
   * Checks that the transport is usable — credentials, DNS, TLS.
   *
   * On the interface rather than only on the SMTP class so startup
   * verification stays polymorphic. An `instanceof SmtpMailProvider` check at
   * the call site would have to be revisited for every provider added after
   * it, which is precisely the coupling the interface exists to prevent.
   *
   * Returns a result instead of throwing: an unreachable mail server is a
   * degraded service, not a reason to refuse to start.
   */
  verify(): Promise<MailProviderHealth>;
}
