import { Router, type Express } from 'express';
import { authRouter } from './auth.routes.js';
import { healthRouter } from './health.routes.js';

/**
 * The single place routes are attached to the application.
 *
 * `app.ts` calls this and does not know what an auth route is; adding a
 * feature is one line here plus its own route file, never an edit to the
 * middleware pipeline.
 *
 * **Health is mounted at the root, unversioned, and that is a deliberate
 * departure from the `/api/v1` prefix in docs/04-data-and-api.md §2.** A
 * liveness probe is infrastructure configuration, not API surface: an
 * orchestrator, a load balancer, and an uptime monitor all hard-code the path,
 * and moving it on an API version bump breaks all three at the moment the new
 * version ships. Everything a *client* consumes is versioned; nothing an
 * operator consumes should be.
 */
export const API_PREFIX = '/api/v1';

export function registerRoutes(app: Express): void {
  app.use('/health', healthRouter);

  const api = Router();
  api.use('/auth', authRouter);

  app.use(API_PREFIX, api);
}
