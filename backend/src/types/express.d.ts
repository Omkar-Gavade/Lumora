import type { Logger } from '../lib/logger.js';

/**
 * Augments Express' `Request` with what `request-context` attaches.
 *
 * Declared once, globally, rather than cast at each call site: a handler
 * reading `req.log` should get a typed logger, not `any` with a hopeful
 * comment. `req.actor` joins this in M2 when `authenticate` exists — it is
 * deliberately absent now so that nothing can read an actor that is never set.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id — inbound `X-Request-Id` if valid, else generated. */
      requestId: string;
      /** Request-scoped logger, pre-bound with `requestId`. */
      log: Logger;
      /** `process.hrtime.bigint()` at the start of the request. */
      startedAt: bigint;
    }
  }
}

export {};
