import cors from 'cors';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { env } from '../../config/index.js';
import { ForbiddenError } from '../../domain/errors/index.js';

/**
 * Security headers — step 1 of the chain, before anything can produce a
 * response (docs/03-backend.md §3).
 *
 * The CSP is `default-src 'none'`, which is stricter than helmet's default and
 * correct here: this process serves JSON and nothing else. It renders no HTML,
 * loads no scripts, and embeds no frames, so every fetch directive can be
 * denied outright. The CSP with a nonce described in docs/04 §4 belongs to
 * whatever serves the frontend's `index.html`; that is Vite today, and this
 * API is not it.
 */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // The API is consumed by fetch from another origin; CORS is what governs
    // that, and helmet's default `same-origin` here would contradict it.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS is only meaningful over TLS, and TLS terminates at the proxy in
    // every deployment shape this project targets. Setting it here would
    // either be ignored or, over plain HTTP in development, wrong.
    hsts: false,
  });
}

/**
 * CORS with an explicit allowlist (docs/04-data-and-api.md §4).
 *
 * No wildcard. A wildcard with `credentials: true` is rejected by browsers
 * anyway, and reaching for one is the usual sign of a misdiagnosed CORS
 * failure rather than a decision.
 *
 * Requests with no `Origin` are allowed through: that is server-to-server
 * traffic, curl, and health probes, none of which CORS governs. CORS is a
 * browser mechanism, and refusing an absent origin only breaks monitoring.
 */
export function corsPolicy(): RequestHandler {
  const allowed = new Set(env.CORS_ORIGINS);

  return cors({
    origin(origin, callback) {
      if (origin === undefined || allowed.has(origin)) {
        callback(null, true);
        return;
      }
      // A typed error rather than `callback(null, false)`, which would omit
      // the CORS headers and leave the browser to report an unexplained
      // failure while the server logged a clean 200.
      callback(new ForbiddenError(`Origin ${origin} is not allowed.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    // Lets the browser read the correlation id, so a failed request can be
    // reported with the id an engineer needs to find it.
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });
}
