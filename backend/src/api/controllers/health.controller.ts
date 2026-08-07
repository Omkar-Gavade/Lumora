import type { HealthResponse, ReadinessResponse } from '@lumora/shared';
import type { Request, Response } from 'express';
import { APP_VERSION, env } from '../../config/index.js';
import { checkDatabaseHealth } from '../../db/pool.js';

/**
 * Liveness — "is this process running" (docs/04-data-and-api.md §2.5).
 *
 * Touches no dependency, deliberately. An orchestrator restarts a container
 * whose liveness probe fails, so putting a database check here converts a
 * thirty-second database blip into a restart storm across every instance,
 * right when the database can least afford new connections.
 *
 * Uptime is whole seconds. Sub-second precision on a number that only exists
 * to answer "did this thing restart" is noise.
 */
export function getHealth(_req: Request, res: Response): void {
  const body: HealthResponse = {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    version: APP_VERSION,
    environment: env.NODE_ENV,
  };

  res.status(200).json(body);
}

/**
 * Readiness — "can this process serve traffic".
 *
 * 503 on failure, not 200 with a degraded body. A load balancer reads the
 * status code and nothing else; a 200 saying `"status":"degraded"` keeps the
 * instance in rotation while it is unable to answer, which is the failure this
 * endpoint exists to prevent.
 *
 * `checks` gains the vector store and the LLM provider in M3 and M5. Each new
 * dependency must decide whether it is *required* for readiness — a
 * non-essential dependency that can fail the probe takes the whole service
 * down for a feature nobody was using.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const database = await checkDatabaseHealth();

  const body: ReadinessResponse = {
    status: database.ok ? 'ok' : 'degraded',
    checks: {
      database: {
        status: database.ok ? 'ok' : 'error',
        latencyMs: database.latencyMs,
        // `exactOptionalPropertyTypes` — the key is omitted entirely rather
        // than set to undefined, so the JSON matches the schema.
        ...(database.message === undefined ? {} : { message: database.message }),
      },
    },
  };

  res.status(database.ok ? 200 : 503).json(body);
}
