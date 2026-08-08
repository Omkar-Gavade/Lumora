import type { MailMessage } from '../mail-provider.interface.js';

/**
 * Auth email bodies.
 *
 * Templates live in `providers/mail/templates/` (docs/03-backend.md §2) but are
 * domain content, not transport: they take domain values and return a rendered
 * `MailMessage`, so swapping console for SMTP touches no copy.
 *
 * Deliberately plain HTML with inline styles and no images. Mail clients strip
 * `<style>` blocks, block remote images by default, and render a "modern" email
 * as a broken one — and the only thing that has to work here is a link.
 */

/**
 * Escapes interpolated values.
 *
 * `displayName` is user-supplied and lands in an HTML body. Without escaping,
 * a name of `<img onerror=…>` is stored XSS delivered by our own mail server
 * to the user's inbox.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading: string, body: string, action: { label: string; url: string }): string {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f7f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:#141418;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e8e8ed;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;font-weight:600;">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#55555f;">${body}</p>
      <a href="${action.url}" style="display:inline-block;background:#141418;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 20px;border-radius:6px;">${escapeHtml(action.label)}</a>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6e6e7c;">
        If the button does not work, paste this into your browser:<br />
        <span style="word-break:break-all;">${action.url}</span>
      </p>
    </div>
  </body>
</html>`;
}

export function verificationEmail(params: {
  to: string;
  displayName: string;
  url: string;
  expiresInHours: number;
}): MailMessage {
  const { to, displayName, url, expiresInHours } = params;

  return {
    to,
    subject: 'Verify your Lumora email address',
    text: [
      `Hi ${displayName},`,
      '',
      'Confirm your email address to finish setting up Lumora:',
      url,
      '',
      `This link expires in ${String(expiresInHours)} hours.`,
      'If you did not create a Lumora account, you can ignore this message.',
    ].join('\n'),
    html: layout(
      'Verify your email address',
      `Hi ${escapeHtml(displayName)}, confirm your address to finish setting up Lumora. This link expires in ${String(expiresInHours)} hours.`,
      { label: 'Verify email', url },
    ),
  };
}

export function passwordResetEmail(params: {
  to: string;
  displayName: string;
  url: string;
  expiresInMinutes: number;
}): MailMessage {
  const { to, displayName, url, expiresInMinutes } = params;

  return {
    to,
    subject: 'Reset your Lumora password',
    text: [
      `Hi ${displayName},`,
      '',
      'Use this link to choose a new password:',
      url,
      '',
      `This link expires in ${String(expiresInMinutes)} minutes and can only be used once.`,
      // The reassurance matters: someone who did not request this needs to know
      // that ignoring the email is sufficient, or they will panic-change a
      // password they did not need to change.
      'If you did not request a password reset, you can ignore this message — your password will not change.',
    ].join('\n'),
    html: layout(
      'Reset your password',
      `Hi ${escapeHtml(displayName)}, use the button below to choose a new password. This link expires in ${String(expiresInMinutes)} minutes and can only be used once. If you did not request this, you can ignore this message.`,
      { label: 'Choose a new password', url },
    ),
  };
}

/**
 * Sent *after* a password changes.
 *
 * Not a courtesy: this is the only signal a user gets that their account was
 * taken over by someone who had access to their inbox. It names no link to
 * click, because a "wasn't me" button in an email is itself a phishing target.
 */
export function passwordChangedEmail(params: {
  to: string;
  displayName: string;
  supportUrl: string;
}): MailMessage {
  const { to, displayName, supportUrl } = params;

  return {
    to,
    subject: 'Your Lumora password was changed',
    text: [
      `Hi ${displayName},`,
      '',
      'Your Lumora password was just changed, and every other signed-in device has been signed out.',
      '',
      'If this was not you, someone else may have access to your email account. Reset your password immediately:',
      supportUrl,
    ].join('\n'),
    html: layout(
      'Your password was changed',
      `Hi ${escapeHtml(displayName)}, your Lumora password was just changed and every other signed-in device has been signed out. If this was not you, reset your password immediately.`,
      { label: 'Reset your password', url: supportUrl },
    ),
  };
}
