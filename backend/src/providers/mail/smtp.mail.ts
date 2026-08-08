import nodemailer, { type Transporter } from 'nodemailer';
/*
  `Transporter` defaults its result type to `any`, so `sendMail(...).rejected`
  would be an unchecked property access on a value the compiler knows nothing
  about — and the `rejected` check below is a correctness guard, not a log
  line. Naming the pooled transport's concrete result type restores it.
*/
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import { env } from '../../config/index.js';
import { ProviderError } from '../../domain/errors/index.js';
import { logger } from '../../lib/logger.js';
import type { MailMessage, MailProvider, MailProviderHealth } from './mail-provider.interface.js';

/**
 * How a delivery failure should be treated by whoever asked for it.
 *
 * `transient` — the network, a timeout, or a 4xx SMTP reply. The same message
 *   sent again in a minute will probably work.
 * `permanent` — bad credentials, a rejected recipient, a 5xx reply. Retrying
 *   sends the identical message to the identical failure and burns quota.
 *
 * The distinction is carried on the error rather than left for a caller to
 * re-derive from an SMTP code, so M3's job queue can decide whether to
 * re-enqueue without learning the SMTP protocol.
 */
export type MailFailureKind = 'transient' | 'permanent';

/**
 * Nodemailer's error codes, grouped by what they mean for a retry.
 *
 * These are the library's own `err.code` values, not SMTP replies — they cover
 * everything that fails before a reply is received.
 */
const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

const PERMANENT_CODES = new Set([
  'EAUTH', // credentials rejected — retrying cannot fix it
  'EENVELOPE', // sender or recipient refused
  'EMESSAGE', // the message itself was rejected
]);

interface SmtpErrorShape {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
}

function readSmtpError(error: unknown): SmtpErrorShape {
  if (typeof error !== 'object' || error === null) return {};
  const candidate = error as Record<string, unknown>;
  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.responseCode === 'number' ? { responseCode: candidate.responseCode } : {}),
    ...(typeof candidate.response === 'string' ? { response: candidate.response } : {}),
    ...(typeof candidate.command === 'string' ? { command: candidate.command } : {}),
  };
}

/**
 * Classifies a failure.
 *
 * The SMTP reply code is consulted **first** and is authoritative: RFC 5321
 * defines 4xx as "try again later" and 5xx as "do not". A `responseCode` of
 * 421 arriving with a code of `EENVELOPE` is a throttle, not a bad address,
 * and treating it as permanent would silently drop mail during a rate-limit
 * window — which is exactly when a provider throttles.
 */
export function classifyMailFailure(error: unknown): MailFailureKind {
  const { code, responseCode } = readSmtpError(error);

  if (responseCode !== undefined) {
    if (responseCode >= 400 && responseCode < 500) return 'transient';
    if (responseCode >= 500) return 'permanent';
  }

  if (code !== undefined) {
    if (TRANSIENT_CODES.has(code)) return 'transient';
    if (PERMANENT_CODES.has(code)) return 'permanent';
  }

  // Unknown failures are treated as transient. Retrying something permanent
  // wastes a few attempts; refusing to retry something transient silently
  // loses a verification email the user is waiting on.
  return 'transient';
}

/**
 * SMTP delivery via Nodemailer (docs/03-backend.md §2, `smtp.mail.ts`).
 *
 * The transport is **pooled and built once**. A fresh connection per message
 * would pay a TCP handshake, a TLS handshake, and an AUTH round trip for every
 * email — roughly a second of latency on a flow the user is actively waiting
 * through, and a fast route to a provider's connection-rate limit during a
 * burst.
 */
export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';

  private readonly transporter: Transporter<SMTPPool.SentMessageInfo>;

  constructor() {
    // Annotated rather than inferred so `createTransport` resolves to the
    // pooled overload, which is what types `sendMail`'s result.
    const options: SMTPPool.Options = {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,

      /*
        Refuse to send in cleartext.

        With `secure: false` Nodemailer will happily continue over an
        unencrypted socket when the server does not offer STARTTLS — which is
        also exactly what a downgrade attacker arranges. `requireTLS` turns
        that into a failed send instead of a silent one, so credentials and
        one-time links are never on the wire in the clear. Redundant when
        `secure` is true (the socket is already TLS), harmless to set.
      */
      requireTLS: !env.SMTP_SECURE,

      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASSWORD,
      },

      // Three distinct failure points, so a log says which one tripped.
      connectionTimeout: env.SMTP_CONNECTION_TIMEOUT,
      greetingTimeout: env.SMTP_GREETING_TIMEOUT,
      socketTimeout: env.SMTP_SOCKET_TIMEOUT,

      pool: true,
      maxConnections: 3,
      maxMessages: 100,
    };

    this.transporter = nodemailer.createTransport(options);
  }

  async verify(): Promise<MailProviderHealth> {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

    try {
      // Opens a connection, runs the TLS handshake, and authenticates without
      // sending anything — the whole point is to surface a bad App Password at
      // boot rather than on a user's first signup.
      await this.transporter.verify();
      return { ok: true, latencyMs: elapsedMs() };
    } catch (error) {
      const details = readSmtpError(error);
      logger.error(
        { err: error, host: env.SMTP_HOST, port: env.SMTP_PORT, ...details },
        'SMTP verification failed',
      );
      return {
        ok: false,
        latencyMs: elapsedMs(),
        message: describeFailure(error),
      };
    }
  }

  async send(message: MailMessage): Promise<void> {
    const startedAt = process.hrtime.bigint();

    try {
      const result = await this.transporter.sendMail({
        // `MAIL_FROM` and not the recipient's anything. For Gmail this must
        // resolve to the authenticated account or the server silently rewrites
        // it, which breaks DKIM alignment and lands mail in spam.
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      logger.info(
        {
          to: message.to,
          subject: message.subject,
          messageId: result.messageId,
          accepted: result.accepted.length,
          rejected: result.rejected.length,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        },
        'Mail sent',
      );

      /*
        A 250 on the transaction does not mean every recipient was accepted —
        with one recipient this is belt and braces, but reading `rejected`
        rather than assuming success is what stops a silently dropped address
        from looking like a delivered email in the logs.
      */
      if (result.rejected.length > 0) {
        throw new ProviderError(
          this.name,
          'The mail server rejected the recipient address.',
          new Error(`Rejected: ${result.rejected.join(', ')}`),
        );
      }
    } catch (error) {
      throw this.toProviderError(error, message);
    }
  }

  /**
   * Maps a transport failure to the documented `ProviderError` (502).
   *
   * The provider's own message is never forwarded to the client: SMTP replies
   * routinely echo the envelope, internal hostnames, and policy details. It
   * goes to the log with the request id; the caller gets a fixed sentence.
   */
  private toProviderError(error: unknown, message: MailMessage): ProviderError {
    if (error instanceof ProviderError) return error;

    const kind = classifyMailFailure(error);
    const details = readSmtpError(error);

    logger.error(
      {
        err: error,
        to: message.to,
        subject: message.subject,
        failureKind: kind,
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        ...details,
      },
      'Mail delivery failed',
    );

    const providerError = new ProviderError(
      this.name,
      'We could not send that email just now. Please try again in a moment.',
      error,
    );

    // Attached rather than encoded in the message, so a retry policy can read
    // it without string matching.
    Object.assign(providerError, { failureKind: kind });
    return providerError;
  }
}

/**
 * A short, non-revealing summary for a health result.
 *
 * `verify()` output can surface to an operator, so it names the failure class
 * without reproducing a server reply that may contain the account address.
 */
function describeFailure(error: unknown): string {
  const { code, responseCode } = readSmtpError(error);

  if (code === 'EAUTH') {
    return 'authentication rejected — check SMTP_USER and SMTP_PASSWORD (Gmail requires an App Password)';
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ECONNREFUSED') {
    return `could not reach ${String(env.SMTP_HOST)}:${String(env.SMTP_PORT)}`;
  }
  if (code === 'EDNS' || code === 'EAI_AGAIN') {
    return `could not resolve ${String(env.SMTP_HOST)}`;
  }
  if (responseCode !== undefined) return `server replied ${String(responseCode)}`;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'connection failed';
}
