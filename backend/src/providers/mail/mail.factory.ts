import { env } from '../../config/index.js';
import { ConsoleMailProvider } from './console.mail.js';
import type { MailProvider } from './mail-provider.interface.js';
import { SmtpMailProvider } from './smtp.mail.js';

/**
 * Resolves the configured driver — the one place a transport is chosen.
 *
 * The `switch` has no `default`, deliberately. `MAIL_DRIVER` is a Zod enum, so
 * adding `'resend'` to it without adding an arm here is a compile error rather
 * than a runtime fallback to console — which would otherwise mean a production
 * deploy that logs verification links instead of sending them, and reports
 * success while doing it.
 *
 * Adding a provider is: one file implementing `MailProvider`, one enum member,
 * one arm. Nothing in the services changes.
 */
export function createMailProvider(): MailProvider {
  switch (env.MAIL_DRIVER) {
    case 'console':
      return new ConsoleMailProvider();
    case 'smtp':
      return new SmtpMailProvider();
  }
}

export const mailProvider: MailProvider = createMailProvider();
