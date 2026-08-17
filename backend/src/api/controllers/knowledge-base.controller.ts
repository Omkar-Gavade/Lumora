import type { Request, Response } from 'express';
import type {
  AddKnowledgeBaseDocumentsRequest,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
} from '@lumora/shared';
import type { Actor } from '../../domain/entities/user.js';
import { UnauthorizedError } from '../../domain/errors/index.js';
import { knowledgeBaseService } from '../../services/knowledge/knowledge-base.service.js';

/**
 * Knowledge Base endpoints (docs/07-knowledge-base.md §7).
 *
 * Controllers read validated input, call one service, and map the result — no
 * business rules and no SQL (docs/03-backend.md §1). **The user id comes from
 * `req.actor`, never from the body or the query**, which is what makes every
 * ownership check below unforgeable.
 */

function requireActor(req: Request): Actor {
  if (!req.actor) throw new UnauthorizedError();
  return req.actor;
}

/** The validated `:id`. `validate({ params })` has already parsed it. */
function idParam(req: Request, key = 'id'): string {
  return (req.params as unknown as Record<string, string>)[key] ?? '';
}

export async function create(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as CreateKnowledgeBaseRequest;

  const base = await knowledgeBaseService.create(actor.userId, {
    name: body.name,
    description: body.description,
  });

  res.status(201).json(base);
}

export async function list(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  res.json(await knowledgeBaseService.list(actor.userId));
}

export async function detail(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  res.json(await knowledgeBaseService.get(actor.userId, idParam(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as UpdateKnowledgeBaseRequest;

  res.json(await knowledgeBaseService.update(actor.userId, idParam(req), body));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  await knowledgeBaseService.delete(actor.userId, idParam(req));
  res.status(204).send();
}

/** The delete confirmation needs to say how many conversations become unscoped. */
export async function impact(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  const conversationCount = await knowledgeBaseService.affectedConversationCount(
    actor.userId,
    idParam(req),
  );

  res.json({ conversationCount });
}

export async function listDocuments(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  res.json(await knowledgeBaseService.listDocuments(actor.userId, idParam(req)));
}

export async function addDocuments(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as AddKnowledgeBaseDocumentsRequest;

  res.json(
    await knowledgeBaseService.addDocuments(actor.userId, idParam(req), body.documentIds),
  );
}

export async function removeDocument(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);

  await knowledgeBaseService.removeDocument(
    actor.userId,
    idParam(req),
    idParam(req, 'documentId'),
  );

  res.status(204).send();
}
