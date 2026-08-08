import { env } from '../../config/index.js';
import { ConsoleMailProvider } from './console.mail.js';
import type { MailProvider } from './mail-provider.interface.js';

/**
 * Resolves the configured driver.
 *
 * A factory over a single implementation looks like ceremony, and would be if
 * the interface existed for its own sake. It exists because the SMTP driver is
 * a known, scheduled second implementation — and because a `switch` that the
 * compiler proves exhaustive is how adding one becomes a two-line change
 * instead of a search for every `new ConsoleMailProvider()`.
 */
export function createMailProvider(): MailProvider {
  switch (env.MAIL_DRIVER) {
    case 'console':
      return new ConsoleMailProvider();
  }
}

export const mailProvider: MailProvider = createMailProvider();
