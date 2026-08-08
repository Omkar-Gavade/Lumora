import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { JSON_BODY_LIMIT, URLENCODED_BODY_LIMIT } from './config/index.js';
import { registerRoutes } from './api/routes/index.js';
import { errorHandler } from './api/middleware/error-handler.js';
import { notFoundHandler } from './api/middleware/not-found.js';
import { requestContext } from './api/middleware/request-context.js';
import { corsPolicy, securityHeaders } from './api/middleware/security.js';

/**
 * Assembles the Express application. **Does not listen** — that is `server.ts`.
 *
 * The split is what makes the HTTP surface testable (docs/03-backend.md §2):
 * an integration test hands this object to supertest and gets the real
 * middleware chain, the real error handler, and the real routes, on an
 * ephemeral port, with no process lifecycle to manage.
 *
 * Order is the chain in docs §3 and is not arbitrary — each step below says
 * what breaks if it moves.
 */
export function createApp(): Express {
  const app = express();

  /*
    Advertises Express and its version to anyone scanning. Free reconnaissance,
    no benefit. Off before any handler can respond.
  */
  app.disable('x-powered-by');

  /*
    Required for correct client IPs behind a reverse proxy. `1` trusts exactly
    one hop — the proxy in front of this process. `true` would trust the entire
    `X-Forwarded-For` chain, which a client can forge, and that turns every
    per-IP rate limit (M2) into a formality.
  */
  app.set('trust proxy', 1);

  // 1 — security headers, before anything can produce a response.
  app.use(securityHeaders());

  /*
    2 — request id, timing, child logger.

    **This runs before CORS, which swaps steps 2 and 3 of the chain in
    docs/03-backend.md §3.** The documented order was verified and found to
    have a hole: CORS rejects a disallowed origin by calling `next(error)`,
    and with `request-context` still downstream that error reaches the terminal
    handler on a request that has no logger and no id. The rejection is
    therefore untraceable — and, before the handler was made defensive, it
    threw and Express answered with an HTML page containing a stack trace.

    Context must be established before anything that can fail. Nothing is lost
    by the swap: CORS still precedes every route, so preflight is answered and
    a disallowed origin never reaches a handler.
  */
  app.use(requestContext);

  // 3 — CORS. After helmet, so a preflight response also carries the security
  //     headers; before the routes, so preflight never reaches one.
  app.use(corsPolicy());

  // 4 — body parsers. Small limits: document bytes arrive as multipart on a
  //     dedicated route in M3, not through here.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));

  // 5 — cookies. The refresh token travels as one, so this must precede the
  //     auth routes that read it.
  app.use(cookieParser());

  /*
    6 — global rate limit: not mounted.

    docs/04-data-and-api.md §3.4 specifies a 300/15min per-IP ceiling, and it
    belongs to the whole API surface rather than to authentication. The auth
    endpoints carry their own, stricter, per-route limits; the global ceiling
    lands when there are non-auth routes for it to protect.
  */

  // 7 — routes.
  registerRoutes(app);

  // 8 — unmatched paths, as a typed error rather than Express' HTML 404.
  app.use(notFoundHandler);

  // 9 — terminal handler. Last, unconditionally: anything registered after it
  //     never runs, because nothing calls `next()` past this point.
  app.use(errorHandler);

  return app;
}
