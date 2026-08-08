import { describe, expect, it } from 'vitest';
import {
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from '../../src/providers/mail/templates/auth.templates.js';
import { escapeHtml } from '../../src/providers/mail/templates/layout.js';
import { ConsoleMailProvider } from '../../src/providers/mail/console.mail.js';
import { classifyMailFailure } from '../../src/providers/mail/smtp.mail.js';
import { FakeMailProvider } from '../fixtures/fake-mail.provider.js';
import type { MailProvider } from '../../src/providers/mail/mail-provider.interface.js';

const URL_WITH_TOKEN = 'http://localhost:5173/verify-email?token=abc-DEF_123';

describe('email templates', () => {
  const templates = [
    ['verification', verificationEmail({ to: 'a@b.com', displayName: 'Omkar', url: URL_WITH_TOKEN, expiresInHours: 24 })],
    ['password reset', passwordResetEmail({ to: 'a@b.com', displayName: 'Omkar', url: URL_WITH_TOKEN, expiresInMinutes: 60 })],
    ['password changed', passwordChangedEmail({ to: 'a@b.com', displayName: 'Omkar', supportUrl: URL_WITH_TOKEN })],
  ] as const;

  it.each(templates)('%s carries both a text and an HTML part', (_name, message) => {
    // A message with no text part scores as spam with most filters, and a
    // verification link in spam is an activation funnel that silently ends.
    expect(message.text.length).toBeGreaterThan(50);
    expect(message.html.length).toBeGreaterThan(200);
    expect(message.subject).not.toBe('');
    expect(message.to).toBe('a@b.com');
  });

  it.each(templates)('%s puts the action URL in both parts', (_name, message) => {
    expect(message.text).toContain(URL_WITH_TOKEN);
    expect(message.html).toContain(URL_WITH_TOKEN);
  });

  it.each(templates)('%s declares dark-mode support', (_name, message) => {
    expect(message.html).toContain('prefers-color-scheme: dark');
    expect(message.html).toContain('name="color-scheme"');
  });

  it.each(templates)('%s is responsive and declares a language', (_name, message) => {
    expect(message.html).toContain('name="viewport"');
    expect(message.html).toContain('max-width: 480px');
    expect(message.html).toContain('<html lang="en"');
  });

  it.each(templates)('%s keeps layout tables out of the accessibility tree', (_name, message) => {
    // Otherwise a screen reader announces a grid instead of reading prose.
    expect(message.html).toContain('role="presentation"');
  });

  it.each(templates)('%s carries an inbox preheader', (_name, message) => {
    // Without one, clients scrape the first visible text — which would be the
    // word "Lumora" for every email we send.
    expect(message.html).toContain('mso-hide:all');
  });

  it('states the expiry in both parts, so the reader knows the link is perishable', () => {
    const message = verificationEmail({ to: 'a@b.com', displayName: 'O', url: URL_WITH_TOKEN, expiresInHours: 24 });
    expect(message.text).toContain('24 hours');
    expect(message.html).toContain('24 hours');
  });

  it('tells a password-reset recipient that ignoring it is safe', () => {
    // Someone who did not request this needs to know that doing nothing is
    // sufficient, or they will panic-change a password that was never at risk.
    const message = passwordResetEmail({ to: 'a@b.com', displayName: 'O', url: URL_WITH_TOKEN, expiresInMinutes: 60 });
    expect(message.text).toContain('your password will not change');
  });
});

describe('template escaping', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;',
    );
  });

  it('neutralizes a hostile display name in the rendered body', () => {
    /*
      `displayName` is user-supplied and lands in a message we send from our
      own domain. Unescaped, it is stored XSS that we deliver to the user's
      inbox ourselves — and mail clients that render HTML are a real
      execution surface.
    */
    const hostile = '<script>alert(document.cookie)</script>';
    const message = verificationEmail({
      to: 'a@b.com',
      displayName: hostile,
      url: URL_WITH_TOKEN,
      expiresInHours: 24,
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});

describe('the provider abstraction', () => {
  it('is satisfied structurally by every implementation', () => {
    // The contract is what keeps the services transport-agnostic: a change to
    // it breaks compilation in the fake rather than being discovered when the
    // fake silently diverges from the real driver.
    const providers: MailProvider[] = [new ConsoleMailProvider(), new FakeMailProvider()];

    for (const provider of providers) {
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.send).toBe('function');
      expect(typeof provider.verify).toBe('function');
    }
  });

  it('reports the console driver as always healthy — there is no transport to check', async () => {
    await expect(new ConsoleMailProvider().verify()).resolves.toMatchObject({ ok: true });
  });

  it('records messages in the fake, so flows can be asserted without a socket', async () => {
    const fake = new FakeMailProvider();
    await fake.send({ to: 'a@b.com', subject: 'S', text: 't', html: '<p>h</p>' });

    expect(fake.outbox).toHaveLength(1);
    expect(fake.lastTo('a@b.com')?.subject).toBe('S');

    fake.clear();
    expect(fake.outbox).toHaveLength(0);
  });

  it('propagates a forced failure, so delivery-failure paths are testable', async () => {
    const fake = new FakeMailProvider();
    fake.failure = new Error('smtp is down');

    await expect(fake.send({ to: 'a@b.com', subject: 'S', text: 't', html: 'h' })).rejects.toThrow(
      'smtp is down',
    );
  });
});

describe('SMTP failure classification', () => {
  it.each([
    ['a 4xx reply is a throttle, not a rejection', { responseCode: 421 }, 'transient'],
    ['a 5xx reply is permanent', { responseCode: 550 }, 'permanent'],
    ['a connection failure is transient', { code: 'ECONNECTION' }, 'transient'],
    ['a timeout is transient', { code: 'ETIMEDOUT' }, 'transient'],
    ['a DNS failure is transient', { code: 'EDNS' }, 'transient'],
    ['bad credentials are permanent', { code: 'EAUTH' }, 'permanent'],
    ['a refused envelope is permanent', { code: 'EENVELOPE' }, 'permanent'],
  ])('%s', (_label, shape, expected) => {
    expect(classifyMailFailure(Object.assign(new Error('x'), shape))).toBe(expected);
  });

  it('lets the SMTP reply code win over the library code', () => {
    /*
      RFC 5321 defines 4xx as "try again later". A 421 arriving with
      `EENVELOPE` is a throttle, and treating it as permanent would silently
      drop mail during a rate-limit window — which is exactly when a provider
      throttles.
    */
    const throttled = Object.assign(new Error('x'), { code: 'EENVELOPE', responseCode: 421 });
    expect(classifyMailFailure(throttled)).toBe('transient');
  });

  it('treats an unrecognized failure as transient', () => {
    // Retrying something permanent wastes a few attempts; refusing to retry
    // something transient silently loses an email the user is waiting on.
    expect(classifyMailFailure(new Error('who knows'))).toBe('transient');
    expect(classifyMailFailure(undefined)).toBe('transient');
  });
});
