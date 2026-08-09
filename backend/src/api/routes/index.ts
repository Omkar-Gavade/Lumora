import { Router, type Express } from 'express';
import { env } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { authRouter } from './auth.routes.js';
import { conversationRouter, messageRouter } from './conversation.routes.js';
import { documentRouter } from './document.routes.js';
import { healthRouter } from './health.routes.js';
import { searchRouter } from './search.routes.js';

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
  api.use('/documents', documentRouter);
  api.use('/conversations', conversationRouter);
  // Mounted at the root of the API rather than under a conversation, matching
  // the documented path in docs/04-data-and-api.md §2.4.
  api.use('/messages', messageRouter);

  /*
    Retrieval is mounted conditionally.

    docs/06-roadmap.md describes it as a development-only tool and
    docs/04-data-and-api.md §2 does not list it, so a deployed service does not
    expose it unless an operator asks. Not mounting is stronger than a
    middleware guard: the route does not exist, so it answers 404 like any
    other unknown path rather than advertising a disabled feature.
  */
  if (env.SEARCH_API_ENABLED) {
    api.use('/search', searchRouter);
  } else {
    logger.info({}, 'Search API disabled — set SEARCH_API_ENABLED=true to expose it');
  }

  app.use(API_PREFIX, api);
}
