import { Router } from 'express';
import { getHealth, getReadiness } from '../controllers/health.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';

/**
 * Health routes.
 *
 * A route file binds paths, methods, and middleware — and holds no logic
 * (docs/03-backend.md §1). Both handlers live in the controller so that
 * "what runs" and "when it runs" stay separately readable.
 *
 * Neither route is authenticated. A probe cannot hold credentials, and the
 * responses carry no user data — a version string and a boolean per
 * dependency. `getReadiness` deliberately reports *that* the database failed,
 * never *why*: the underlying error goes to the log.
 */
export const healthRouter: Router = Router();

healthRouter.get('/', getHealth);
healthRouter.get('/ready', asyncHandler(getReadiness));
