import { logger } from '../../lib/logger.js';
import type { MailMessage, MailProvider } from './mail-provider.interface.js';

/**
 * The development driver: writes the message to the log instead of sending it
 * (docs/03-backend.md §2 — "dev: logs the link").
 *
 * It logs the **text** body, not the HTML. The text part carries the same link
 * and is readable in a terminal; dumping HTML into a log makes the one thing
 * anyone wants — the URL — the hardest thing to find.
 *
 * Recipient and subject go through as ordinary fields. `to` is an address the
 * user just typed, not a secret, and being able to see which address a link
 * went to is the entire point of a console driver.
 */
export class ConsoleMailProvider implements MailProvider {
  readonly name = 'console';

  send(message: MailMessage): Promise<void> {
    logger.info(
      { to: message.to, subject: message.subject, body: message.text },
      'Mail (console driver — not delivered)',
    );
    return Promise.resolve();
  }
}
