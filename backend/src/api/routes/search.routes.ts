import { searchQueryParamsSchema, searchRequestSchema } from '@lumora/shared';
import { Router } from 'express';
import * as searchController from '../controllers/search.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { authenticate, requireVerified } from '../middleware/authenticate.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';

const MINUTE = 60 * 1000;

/**
 * Retrieval routes — the debugging surface from docs/06-roadmap.md M4.
 *
 * **These are not in docs/04-data-and-api.md §2's API table.** The documented
 * artefact is "a development-only endpoint that returns retrieval results
 * without generation", which is what this is; the concrete paths and the
 * response contract are new, because the docs specify neither. Mounting is
 * gated on `SEARCH_API_ENABLED`, which defaults off in production — see
 * `config/env.ts` for the reasoning.
 *
 * `authenticate` then `requireVerified`, matching documents: retrieval reads a
 * user's own corpus, and every result is a passage from a file they uploaded.
 * Tenancy is not enforced here but structurally — a per-user vector collection
 * and `user_id` on every lexical query — so a bug in this file cannot leak
 * another account's documents.
 */
export const searchRouter: Router = Router();

searchRouter.use(authenticate, requireVerified);

/**
 * 60/minute per user.
 *
 * Retrieval costs an embedding call per query, which is real money
 * (docs/06-roadmap.md R3), and the search page fires one per submission. A
 * per-minute limit rather than per-hour because the failure this guards
 * against is a stuck client in a loop, which does its damage in seconds.
 * Keyed by user, not IP: an office behind one NAT would otherwise share an
 * allowance.
 */
const searchRateLimit = rateLimit({
  name: 'search',
  limit: 60,
  windowMs: MINUTE,
  keyOf: (req) => req.actor?.userId ?? null,
});

searchRouter.get(
  '/',
  searchRateLimit,
  validate({ query: searchQueryParamsSchema }),
  asyncHandler(searchController.search),
);

searchRouter.post(
  '/',
  searchRateLimit,
  validate({ body: searchRequestSchema }),
  asyncHandler(searchController.searchPost),
);
