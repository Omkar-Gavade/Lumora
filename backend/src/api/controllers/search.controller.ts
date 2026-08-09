import type { Request, Response } from 'express';
import type { SearchQueryParams, SearchRequest } from '@lumora/shared';
import type { Actor } from '../../domain/entities/user.js';
import { UnauthorizedError } from '../../domain/errors/index.js';
import { retrievalService } from '../../services/retrieval/retrieval.service.js';

/**
 * The retrieval-only endpoint (docs/06-roadmap.md M4).
 *
 * "**The retrieval-only endpoint is the most valuable debugging tool in the
 * project.** Without it, 'the answer is wrong' is unattributable between
 * retrieval and generation."
 *
 * It answers `200` with the Evidence Bundle — including when the bundle
 * abstains. An abstention is a successful retrieval that found nothing worth
 * answering from, not a failed request, and a `404` would make the client
 * treat a correct answer as an error.
 */

/**
 * Local, matching the other controllers.
 *
 * `authenticate` has already rejected an unauthenticated request by the time a
 * handler runs, so this narrows what the middleware guaranteed rather than
 * re-checking it.
 */
function requireActor(req: Request): Actor {
  if (!req.actor) throw new UnauthorizedError();
  return req.actor;
}

/** `GET /search?q=…&k=…&documentId=…` — the browser and curl form. */
export async function search(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const params = req.query as unknown as SearchQueryParams;

  const bundle = await retrievalService.retrieve({
    userId: actor.userId,
    query: params.q,
    topK: params.k,
    documentIds: params.documentId,
  });

  res.status(200).json(bundle);
}

/** `POST /search` — the structured form, for filters that are lists. */
export async function searchPost(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as SearchRequest;

  const bundle = await retrievalService.retrieve({
    userId: actor.userId,
    query: body.query,
    topK: body.topK,
    documentIds: body.filters?.documentIds,
  });

  res.status(200).json(bundle);
}
