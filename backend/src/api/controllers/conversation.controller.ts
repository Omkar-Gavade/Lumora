import type { Request, Response } from 'express';
import type {
  CreateConversationRequest,
  ListConversationsQuery,
  SendMessageRequest,
  TurnDto,
  UpdateConversationRequest,
} from '@lumora/shared';
import type { Actor } from '../../domain/entities/user.js';
import { UnauthorizedError } from '../../domain/errors/index.js';
import { chatService } from '../../services/chat/chat.service.js';
import {
  conversationService,
  toMessageDto,
} from '../../services/chat/conversation.service.js';

/**
 * Conversation and message endpoints (docs/04-data-and-api.md §2.4).
 *
 * Controllers read validated input, call one service, and map the result to an
 * HTTP response — no business rules, no SQL (docs/03-backend.md §1).
 */

function requireActor(req: Request): Actor {
  if (!req.actor) throw new UnauthorizedError();
  return req.actor;
}

/**
 * The validated `:id`.
 *
 * Express 5 types every param as `string | string[]`. `validate({ params })`
 * has already replaced `req.params` with the parsed object, so this reads what
 * validation produced rather than asserting a shape nothing checked.
 */
function idFrom(req: Request): string {
  const { id } = req.params as unknown as { id: string };
  return id;
}

export async function create(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as CreateConversationRequest;

  res.status(201).json(await conversationService.create(actor.userId, body.title));
}

export async function list(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const query = req.query as unknown as ListConversationsQuery;

  res.status(200).json(
    await conversationService.list(actor.userId, {
      limit: query.limit,
      cursor: query.cursor,
      includeArchived: query.includeArchived,
    }),
  );
}

export async function detail(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  res.status(200).json(await conversationService.detail(actor.userId, idFrom(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as UpdateConversationRequest;

  res.status(200).json(await conversationService.update(actor.userId, idFrom(req), body));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  await conversationService.delete(actor.userId, idFrom(req));
  res.status(204).end();
}

export async function removeMessage(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  await conversationService.deleteMessage(actor.userId, idFrom(req));
  res.status(204).end();
}

/**
 * `POST /conversations/:id/messages` — one turn, non-streaming.
 *
 * docs §2.4 specifies this endpoint as an **SSE stream**, and it will be: the
 * streaming orchestrator is the next milestone. Until then it answers JSON, so
 * the turn lifecycle — retrieval, prompt assembly, citation mapping,
 * persistence — is exercised and verifiable without a socket. That ordering is
 * docs/06-roadmap.md's own: "non-streaming turn first (prove retrieval →
 * prompt → answer → persistence), then streaming".
 *
 * 201, matching the documented convention for a create: the request produced
 * two message rows.
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as SendMessageRequest;

  const turn = await chatService.sendMessage({
    userId: actor.userId,
    conversationId: idFrom(req),
    content: body.content,
  });

  const empty = new Map<string, string>();

  const payload: TurnDto = {
    userMessage: toMessageDto(turn.userMessage, [], empty),
    // Citations are projected from what was just mapped rather than re-read:
    // the rows were written in the same request, and a round trip to fetch
    // them back would only prove the database still works.
    assistantMessage: {
      ...toMessageDto(turn.assistantMessage, [], empty),
      citations: turn.citations.map((citation) => ({
        citationIndex: citation.citationIndex,
        chunkId: citation.chunkId,
        documentId: citation.documentId,
        documentTitle:
          turn.sources.find((source) => source.chunkId === citation.chunkId)?.documentTitle ?? null,
        pageNumber:
          turn.sources.find((source) => source.chunkId === citation.chunkId)?.pageNumber ?? null,
        sectionPath:
          turn.sources.find((source) => source.chunkId === citation.chunkId)?.sectionPath ?? null,
        score: citation.score,
        contentSnapshot: citation.contentSnapshot,
      })),
    },
    sources: turn.sources.map((source, index) => ({
      // The prompt's numbering, which is also the UI's (§4.2).
      index: index + 1,
      chunkId: source.chunkId,
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      text: source.text,
      pageNumber: source.pageNumber,
      sectionPath: source.sectionPath,
      score: source.score,
    })),
    abstained: turn.abstained,
  };

  res.status(201).json(payload);
}
