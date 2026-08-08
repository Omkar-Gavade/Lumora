import type { Actor } from '../domain/entities/user.js';
import type { Logger } from '../lib/logger.js';

/**
 * Augments Express' `Request` with what the middleware chain attaches.
 *
 * Declared once, globally, rather than cast at each call site: a handler
 * reading `req.log` should get a typed logger, not `any` with a hopeful
 * comment.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id — inbound `X-Request-Id` if valid, else generated. */
      requestId: string;
      /** Request-scoped logger, pre-bound with `requestId` and `userId`. */
      log: Logger;
      /** `process.hrtime.bigint()` at the start of the request. */
      startedAt: bigint;
      /**
       * The authenticated caller, attached by `authenticate`.
       *
       * Optional, and deliberately so. Marking it required would type every
       * public route as having an actor and turn a missing `authenticate` into
       * a runtime `undefined` instead of a compile error at the point of use.
       */
      actor?: Actor;
    }
  }
}

export {};
