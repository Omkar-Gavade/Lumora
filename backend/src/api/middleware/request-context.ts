import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_PATTERN,
} from '../../config/index.js';
import { logger } from '../../lib/logger.js';

/**
 * Honors an inbound request id, or rejects it.
 *
 * The header is attacker-controlled and lands in every log line for the
 * request, so it is validated before it is trusted: bounded length, and a
 * character set with no newlines. Without that, a crafted `X-Request-Id`
 * injects forged entries into a log stream — the classic log-injection
 * primitive, and a real one for anything that later parses those logs.
 *
 * An invalid header is silently replaced rather than rejected with a 400. The
 * id is diagnostic metadata; failing a legitimate request over a malformed
 * trace header would be a worse outcome than losing the correlation.
 */
function resolveRequestId(header: unknown): string {
  if (
    typeof header === 'string' &&
    header.length > 0 &&
    header.length <= REQUEST_ID_MAX_LENGTH &&
    REQUEST_ID_PATTERN.test(header)
  ) {
    return header;
  }
  return `req_${randomUUID()}`;
}

/**
 * Establishes per-request identity, timing, and a bound logger — step 3 of the
 * chain in docs/03-backend.md §3, before anything that might want to log.
 *
 * The request id is echoed on the response *immediately*, not at finish, so it
 * is present even on a response written by an error handler that never reached
 * the normal path. It is the same id that appears in the error body
 * (docs §4), which is what lets a user report "request req_… failed" and have
 * an engineer find it.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = resolveRequestId(req.get(REQUEST_ID_HEADER));
  req.startedAt = process.hrtime.bigint();
  req.log = logger.child({ requestId: req.requestId });

  res.setHeader(REQUEST_ID_HEADER, req.requestId);

  req.log.debug({ method: req.method, path: req.originalUrl }, 'Request started');

  /*
    `finish` rather than `close`: it fires when the response has been handed to
    the OS, so `statusCode` and the byte count are final. `close` also fires
    when the client hangs up mid-response, which would log a status that was
    never actually sent.
  */
  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - req.startedAt) / 1_000_000n);
    const contentLength = res.getHeader('content-length');

    /*
      Level follows outcome, so `LOG_LEVEL=warn` in production surfaces exactly
      the requests worth looking at. A 4xx is the client's problem and is not an
      alert; a 5xx is ours.
    */
    const context = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      bytes: typeof contentLength === 'string' ? Number(contentLength) : (contentLength ?? 0),
    };

    if (res.statusCode >= 500) req.log.error(context, 'Request failed');
    else if (res.statusCode >= 400) req.log.warn(context, 'Request rejected');
    else req.log.info(context, 'Request completed');
  });

  next();
}
