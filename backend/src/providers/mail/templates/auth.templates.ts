import type { MailMessage } from '../mail-provider.interface.js';
import { escapeHtml, renderLayout } from './layout.js';

/**
 * Auth email bodies.
 *
 * Templates live in `providers/mail/templates/` (docs/03-backend.md §2) but are
 * domain content, not transport: they take domain values and return a rendered
 * `MailMessage`, so swapping console for SMTP — or SMTP for Resend — touches no
 * copy at all.
 *
 * Every template returns both parts. The text version is written to be read,
 * not generated as a stripped-tags afterthought: it is what plain-text clients,
 * notification previews, and spam filters actually see.
 */

/** Wraps the URL so it survives autolinking in the text part too. */
function plainText(lines: string[]): string {
  return lines.join('\n');
}

export function verificationEmail(params: {
  to: string;
  displayName: string;
  url: string;
  expiresInHours: number;
}): MailMessage {
  const { to, displayName, url, expiresInHours } = params;
  const hours = String(expiresInHours);
  const safeName = escapeHtml(displayName);

  return {
    to,
    subject: 'Verify your Lumora email address',
    text: plainText([
      `Hi ${displayName},`,
      '',
      'Confirm your email address to finish setting up Lumora:',
      url,
      '',
      `This link expires in ${hours} hours and can only be used once.`,
      '',
      'You can sign in before verifying, but uploading documents and asking',
      'questions stay locked until your address is confirmed.',
      '',
      'If you did not create a Lumora account, you can ignore this message.',
      '',
      '— Lumora',
    ]),
    html: renderLayout({
      title: 'Verify your Lumora email address',
      preheader: `Confirm your address to finish setting up Lumora. Expires in ${hours} hours.`,
      heading: 'Verify your email address',
      paragraphs: [
        `Hi ${safeName}, confirm your address to finish setting up Lumora.`,
        // FR-5 restated here, because this is where the user is deciding
        // whether the click matters. "You must verify" without saying what is
        // blocked reads as bureaucracy.
        'You can sign in before verifying — uploading documents and asking questions stay locked until your address is confirmed.',
      ],
      action: { label: 'Verify email', url },
      footnote: `This link expires in ${hours} hours and can only be used once.`,
    }),
  };
}

export function passwordResetEmail(params: {
  to: string;
  displayName: string;
  url: string;
  expiresInMinutes: number;
}): MailMessage {
  const { to, displayName, url, expiresInMinutes } = params;
  const minutes = String(expiresInMinutes);
  const safeName = escapeHtml(displayName);

  return {
    to,
    subject: 'Reset your Lumora password',
    text: plainText([
      `Hi ${displayName},`,
      '',
      'Use this link to choose a new password:',
      url,
      '',
      `This link expires in ${minutes} minutes and can only be used once.`,
      '',
      // The reassurance matters: someone who did not request this needs to
      // know that ignoring the email is sufficient, or they will panic-change
      // a password that was never at risk.
      'If you did not request a password reset, you can ignore this message —',
      'your password will not change.',
      '',
      '— Lumora',
    ]),
    html: renderLayout({
      title: 'Reset your Lumora password',
      preheader: `Choose a new password. This link expires in ${minutes} minutes.`,
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${safeName}, use the button below to choose a new password.`,
        'If you did not request this, you can ignore this message — your password will not change.',
      ],
      action: { label: 'Choose a new password', url },
      footnote: `This link expires in ${minutes} minutes and can only be used once.`,
    }),
  };
}

/**
 * Sent *after* a password changes.
 *
 * Not a courtesy: this is the only signal a user gets that their account was
 * taken over by someone with access to their inbox. The action deliberately
 * points at the ordinary forgot-password flow rather than a one-click "this
 * wasn't me" link — a security email containing a bespoke action URL is
 * indistinguishable from the phishing it would train people to click.
 */
export function passwordChangedEmail(params: {
  to: string;
  displayName: string;
  supportUrl: string;
}): MailMessage {
  const { to, displayName, supportUrl } = params;
  const safeName = escapeHtml(displayName);

  return {
    to,
    subject: 'Your Lumora password was changed',
    text: plainText([
      `Hi ${displayName},`,
      '',
      'Your Lumora password was just changed, and every other signed-in device',
      'has been signed out.',
      '',
      'If this was not you, someone else may have access to your email account.',
      'Reset your password immediately:',
      supportUrl,
      '',
      '— Lumora',
    ]),
    html: renderLayout({
      title: 'Your Lumora password was changed',
      preheader: 'Your password was changed and other devices were signed out.',
      heading: 'Your password was changed',
      paragraphs: [
        `Hi ${safeName}, your Lumora password was just changed and every other signed-in device has been signed out.`,
        'If this was not you, someone else may have access to your email account. Reset your password immediately.',
      ],
      action: { label: 'Reset your password', url: supportUrl },
    }),
  };
}
