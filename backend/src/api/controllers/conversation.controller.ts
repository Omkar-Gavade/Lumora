import type { Request, Response } from 'express';
import type {
  CreateConversationRequest,
  ListConversationsQuery,
  SendMessageRequest,
  TurnDto,
  UpdateConversationRequest,
} from '@lumora/shared';
import { env } from '../../config/index.js';
import type { Actor } from '../../domain/entities/user.js';
import { NotFoundError, UnauthorizedError } from '../../domain/errors/index.js';
import { SseWriter } from '../../lib/sse.js';
import { logger } from '../../lib/logger.js';
import { abortRegistry } from '../../services/chat/abort-registry.js';
import { streamTurn } from '../../services/chat/chat.stream.js';
import { messageRepository } from '../../repositories/message.repository.js';
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

  res
    .status(201)
    .json(await conversationService.create(actor.userId, body.title, body.knowledgeBaseId));
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
  const id = idFrom(req);

  /*
    The scope is written through its own service call, because it is the one
    field with a precondition — the conversation must have no messages
    (docs/07 §2.2) — and folding it into the generic update would either lose
    that guard or impose it on renaming too.
  */
  if (body.knowledgeBaseId !== undefined) {
    const scoped = await conversationService.setKnowledgeBase(
      actor.userId,
      id,
      body.knowledgeBaseId,
    );

    if (body.title === undefined && body.archived === undefined) {
      res.status(200).json(scoped);
      return;
    }
  }

  res.status(200).json(await conversationService.update(actor.userId, id, body));
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
 * `POST /conversations/:id/messages` — **the SSE stream** (docs/04 §2.4).
 *
 * "Returning a stream rather than a JSON body is the one place the API departs
 * from plain REST, and it is deliberate: the alternative — create the message,
 * then open a separate SSE connection to watch it — doubles round trips,
 * introduces a race where the stream is opened after generation has begun, and
 * requires a server-side buffer for tokens emitted in the gap. One request, one
 * stream, one lifecycle."
 *
 * The response is a stream from the first byte, so **failures after the
 * headers are sent become `error` events, not HTTP statuses**. Anything that
 * can be rejected — ownership, validation, rate limits — is rejected before
 * `open()`, which is why the ownership check happens here rather than only
 * inside the service.
 */
export async function streamMessage(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const body = req.body as SendMessageRequest;
  const conversationId = idFrom(req);

  const sse = new SseWriter(res, {
    heartbeatMs: env.STREAM_HEARTBEAT_INTERVAL,
    bufferSize: env.STREAM_BUFFER_SIZE,
  });

  /*
    Ownership is proved *before* the headers go out, so a rejection is still a
    plain 404.

    Once `open()` has written a 200, a `NotFoundError` can only be delivered as
    an `error` event — and a client that asked about someone else's
    conversation would see a stream that opens successfully and then fails,
    which is a worse signal than a status code.
  */
  await assertOwnsConversation(actor.userId, conversationId);

  sse.open();

  try {
    await streamTurn({ userId: actor.userId, conversationId, content: body.content }, sse);
  } catch (error) {
    /*
      A throw that escapes `streamTurn` — it finalizes the message on every
      path it knows about, so reaching here means something outside the turn
      failed. The stream still has to be closed, and the client still has to be
      told, because a socket that just stops looks identical to a hang.
    */
    logger.error({ err: error, conversationId }, 'Stream aborted by an unexpected error');
    sse.emit('error', { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
    sse.close();
  }
}

/**
 * `POST /conversations/:id/stop` — the explicit stop path (docs §2.4, §7).
 *
 * §7: "The client can either abort the fetch (the server's `close` handler
 * fires) or call `POST /conversations/:id/stop` (the registry aborts the
 * controller). Both paths converge on step 11. Two paths exist because the
 * abort signal is unreliable behind some proxies and the explicit endpoint is
 * a guaranteed fallback. **Both are idempotent.**"
 *
 * 204 whether or not a generation was running: "stop" is a request for a state,
 * not for an event, and a 404 for a stream that already finished would make the
 * client report an error for the outcome it wanted.
 */
export async function stopGeneration(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const conversationId = idFrom(req);

  await assertOwnsConversation(actor.userId, conversationId);

  const aborted = abortRegistry.abort(conversationId);
  logger.info({ conversationId, aborted }, 'Stop requested');

  res.status(204).end();
}

/**
 * `POST /conversations/:id/messages/:messageId/regenerate` (docs §2.4).
 *
 * §7: "Regeneration creates a new assistant message with `parent_id` pointing
 * at the replaced one rather than mutating in place, preserving lineage and
 * keeping the option of a version switcher without a schema change."
 *
 * The question is re-read from the thread rather than resent by the client: the
 * user is asking for a different answer to the *same* question, and accepting
 * new text here would silently let a regenerate become an edit.
 */
export async function regenerate(req: Request, res: Response): Promise<void> {
  const actor = requireActor(req);
  const { id: conversationId, messageId } = req.params as unknown as {
    id: string;
    messageId: string;
  };

  await assertOwnsConversation(actor.userId, conversationId);

  const target = await messageRepository.findById(messageId, actor.userId);
  if (target?.conversationId !== conversationId || target.role !== 'assistant') {
    throw new NotFoundError('That message does not exist.');
  }

  // The question that produced it: the user turn immediately before.
  const messages = await messageRepository.listByConversation(conversationId, actor.userId);
  const question = [...messages]
    .filter((message) => message.role === 'user' && message.sequence < target.sequence)
    .at(-1);

  if (question === undefined) throw new NotFoundError('That message has no question to answer.');

  const sse = new SseWriter(res, {
    heartbeatMs: env.STREAM_HEARTBEAT_INTERVAL,
    bufferSize: env.STREAM_BUFFER_SIZE,
  });

  sse.open();

  try {
    await streamTurn(
      {
        userId: actor.userId,
        conversationId,
        content: question.content,
        parentId: target.id,
        existingAssistantId: question.id,
      },
      sse,
    );
  } catch (error) {
    logger.error({ err: error, conversationId }, 'Regeneration aborted by an unexpected error');
    sse.emit('error', { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
    sse.close();
  }
}

/** Proves ownership before a stream commits to a 200. */
async function assertOwnsConversation(userId: string, conversationId: string): Promise<void> {
  const messages = await conversationService.detail(userId, conversationId).catch(() => null);
  if (messages === null) throw new NotFoundError('That conversation does not exist.');
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
