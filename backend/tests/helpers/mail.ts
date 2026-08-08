import { fakeMailProvider } from '../fixtures/fake-mail.provider.js';
import type { MailMessage } from '../../src/providers/mail/mail-provider.interface.js';

export { fakeMailProvider };

/**
 * Pulls a one-time token out of a delivered email.
 *
 * Read from the **message body**, never from `verification_tokens`. The
 * database stores only a SHA-256 hash, so the raw token exists in exactly one
 * place after it is issued — and going through the email is also what proves
 * the link was rendered, addressed, and reachable. A test that read the table
 * would pass against a flow that mailed an empty template.
 *
 * The text part is parsed rather than the HTML: it carries the same URL
 * without markup, and asserting on the plain-text body keeps these helpers
 * working when the HTML layout is restyled.
 */
export function tokenFromMessage(message: MailMessage, path: string): string {
  const pattern = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`);
  const match = pattern.exec(message.text);

  if (!match?.[1]) {
    throw new Error(
      `No "${path}?token=" link in the message body.\n--- body ---\n${message.text}`,
    );
  }
  return match[1];
}

/** The verification token from the most recent email to an address. */
export function verificationTokenFor(email: string): string {
  const message = lastMessageTo(email, 'Verify your Lumora email address');
  return tokenFromMessage(message, '/verify-email');
}

/** The password-reset token from the most recent email to an address. */
export function resetTokenFor(email: string): string {
  const message = lastMessageTo(email, 'Reset your Lumora password');
  return tokenFromMessage(message, '/reset-password');
}

/**
 * The latest message to an address with a given subject.
 *
 * Filtering by subject as well as recipient matters once a flow sends more
 * than one email — a password reset sends the link and then the "your password
 * was changed" notice, and `lastTo(email)` alone would return the wrong one.
 */
export function lastMessageTo(email: string, subject: string): MailMessage {
  const matches = fakeMailProvider
    .allTo(email)
    .filter((message) => message.subject === subject);

  const message = matches.at(-1);
  if (!message) {
    const seen = fakeMailProvider.outbox
      .map((entry) => `  ${entry.to} — ${entry.subject}`)
      .join('\n');
    throw new Error(
      `No message to ${email} with subject "${subject}".\n--- outbox ---\n${seen || '  (empty)'}`,
    );
  }
  return message;
}

/** Count of messages sent to an address, for cooldown and resend assertions. */
export function messageCountFor(email: string): number {
  return fakeMailProvider.allTo(email).length;
}
