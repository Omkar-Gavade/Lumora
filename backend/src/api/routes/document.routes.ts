import { documentIdParamSchema, listDocumentsQuerySchema } from '@lumora/shared';
import { Router } from 'express';
import * as documentController from '../controllers/document.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate, requireVerified } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { uploadFiles } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';

const HOUR = 60 * 60 * 1000;

/**
 * Document routes (docs/04-data-and-api.md §2.3).
 *
 * Every route is `authenticate` then `requireVerified`. FR-5 is explicit that
 * an unverified account keeps the shell and Settings but cannot upload or
 * chat — this is the gate's first real consumer, and the reason it was built
 * as a separate middleware rather than a flag on `authenticate`.
 *
 * `GET /documents/events` (SSE) is documented in §2.3 and is not mounted here:
 * it streams status transitions, and there is no worker producing transitions
 * to stream. It arrives with the pipeline that generates them.
 */
export const documentRouter: Router = Router();

documentRouter.use(authenticate, requireVerified);

/**
 * 20/hour per user (docs/04-data-and-api.md §3.4). Keyed by user rather than
 * by IP: uploading is an authenticated, quota-bearing action, and an office
 * behind one NAT would otherwise share a single allowance.
 */
documentRouter.post(
  '/',
  rateLimit({
    name: 'document-upload',
    limit: 20,
    windowMs: HOUR,
    keyOf: (req) => req.actor?.userId ?? null,
  }),
  uploadFiles('files'),
  asyncHandler(documentController.upload),
);

documentRouter.get(
  '/',
  validate({ query: listDocumentsQuerySchema }),
  asyncHandler(documentController.list),
);

// Before `/:id`, or the literal path is captured as an id and answers 422 on
// a route that should exist.
documentRouter.get('/usage', asyncHandler(documentController.usage));

documentRouter.get(
  '/:id',
  validate({ params: documentIdParamSchema }),
  asyncHandler(documentController.getById),
);

documentRouter.delete(
  '/:id',
  validate({ params: documentIdParamSchema }),
  asyncHandler(documentController.remove),
);

/**
 * Re-enqueues a failed document (docs/04-data-and-api.md §2.3).
 *
 * Rate-limited on its own allowance rather than sharing the upload bucket. A
 * document that fails for a permanent reason — a scanned PDF — will fail again
 * on every retry, and without a limit a frustrated user clicking repeatedly
 * schedules unbounded parse work. The allowance is generous enough that
 * retrying every document in a batch after fixing a genuine outage is not
 * blocked.
 */
documentRouter.post(
  '/:id/retry',
  rateLimit({
    name: 'document-retry',
    limit: 30,
    windowMs: HOUR,
    keyOf: (req) => req.actor?.userId ?? null,
  }),
  validate({ params: documentIdParamSchema }),
  asyncHandler(documentController.retry),
);
