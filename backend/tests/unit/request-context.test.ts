import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../../src/api/middleware/request-context.js';
import { logger } from '../../src/lib/logger.js';

/**
 * What the request logger is allowed to record.
 *
 * docs/03-backend.md §6 treats any field carrying user content as a secret.
 * A query string is where user content reaches a GET endpoint — `GET
 * /search?q=…` carries the user's question about their own private documents —
 * and it reached the logs even though the retrieval service deliberately never
 * logs the query itself.
 */
describe('requestContext logging', () => {
  function run(originalUrl: string): { debug: unknown[]; finish: unknown[] } {
    const debug: unknown[] = [];
    const finish: unknown[] = [];

    const child = {
      debug: (context: unknown) => debug.push(context),
      info: (context: unknown) => finish.push(context),
      warn: (context: unknown) => finish.push(context),
      error: (context: unknown) => finish.push(context),
      fatal: () => undefined,
      child: () => child,
    };

    vi.spyOn(logger, 'child').mockReturnValue(child);

    const listeners = new Map<string, () => void>();
    const req = { method: 'GET', originalUrl, get: () => undefined } as unknown as Request;
    const res = {
      setHeader: () => undefined,
      getHeader: () => '0',
      statusCode: 200,
      on: (event: string, handler: () => void) => listeners.set(event, handler),
    } as unknown as Response;

    requestContext(req, res, (() => undefined) as NextFunction);
    listeners.get('finish')?.();

    vi.restoreAllMocks();
    return { debug, finish };
  }

  it('strips the query string from the logged path', () => {
    const { debug, finish } = run('/api/v1/search?q=what%20is%20my%20notice%20period');

    expect(debug[0]).toMatchObject({ path: '/api/v1/search' });
    expect(finish[0]).toMatchObject({ path: '/api/v1/search' });
    expect(JSON.stringify(finish)).not.toContain('notice');
  });

  it('leaves a path with no query string untouched', () => {
    // Nothing diagnostic is lost: the route still identifies the endpoint.
    expect(run('/api/v1/documents').finish[0]).toMatchObject({ path: '/api/v1/documents' });
  });

  it('strips every parameter, not only the ones known to be sensitive', () => {
    // Redacting by name would work until the next endpoint took a sensitive
    // parameter nobody added to the list.
    const { finish } = run('/api/v1/documents?status=failed&cursor=abc123');

    expect(finish[0]).toMatchObject({ path: '/api/v1/documents' });
    expect(JSON.stringify(finish)).not.toContain('abc123');
  });
});
