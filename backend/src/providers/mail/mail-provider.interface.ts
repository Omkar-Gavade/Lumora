/**
 * One outbound message. Both a text and an HTML body, always.
 *
 * Text is not a fallback nicety: a message with no text part scores as spam
 * with most filters, and a verification link that lands in spam is an
 * activation funnel that silently ends.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Delivery, behind an interface (docs/03-backend.md §1: providers know nothing
 * about Lumora's domain).
 *
 * The interface takes a rendered message, not a "send verification email"
 * method. A provider that knows what a verification email is cannot be swapped
 * without moving the templates too, and the templates are domain, not
 * transport.
 */
export interface MailProvider {
  /** Provider name, for logs. */
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}
