import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import {
  GLOBAL_RATE_LIMIT,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
} from './config/index.js';
import { ipKeyExceptHealth, rateLimit } from './api/middleware/rate-limit.js';
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
    6 — global rate limit: docs/04-data-and-api.md §3.4's 300 / 15 min per IP.

    This is a backstop, not the real defence. Every endpoint worth abusing
    carries its own stricter limit at its router; what this catches is the
    surface those limits do not name — enumeration across many cheap endpoints,
    and any route added later that its author forgot to protect. A ceiling that
    has to be remembered per route is a ceiling that eventually is not.

    Mounted after the body parsers so a rejected request is still logged with
    its parsed context, and before the routes so it applies to all of them.
  */
  app.use(
    rateLimit({
      name: 'global',
      limit: GLOBAL_RATE_LIMIT,
      windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
      keyOf: ipKeyExceptHealth,
    }),
  );

  // 7 — routes.
  registerRoutes(app);

  // 8 — unmatched paths, as a typed error rather than Express' HTML 404.
  app.use(notFoundHandler);

  // 9 — terminal handler. Last, unconditionally: anything registered after it
  //     never runs, because nothing calls `next()` past this point.
  app.use(errorHandler);

  return app;
}
