import type { EvidenceChunkDto, TurnSourceDto } from '@lumora/shared';
import { env } from '../../config/index.js';
import { db } from '../../db/pool.js';
import { NotFoundError } from '../../domain/errors/index.js';
import { logger, type Logger } from '../../lib/logger.js';
import type { SseWriter } from '../../lib/sse.js';
import { llmProvider } from '../../providers/llm/llm.factory.js';
import { ProviderError } from '../../providers/llm/llm-provider.interface.js';
import { citationRepository } from '../../repositories/citation.repository.js';
import { conversationRepository } from '../../repositories/conversation.repository.js';
import { messageRepository, type Message } from '../../repositories/message.repository.js';
import { usageRepository } from '../../repositories/usage.repository.js';
import { retrievalService } from '../retrieval/retrieval.service.js';
import { abortRegistry } from './abort-registry.js';
import { mapCitations, type MappedCitation } from './citation.mapper.js';
import { chatService } from './chat.service.js';
import { buildPrompt } from './prompt.builder.js';
import { ABSTENTION_MESSAGE, EMPTY_CORPUS_MESSAGE } from './system-prompt.js';

export interface StreamTurnInput {
  userId: string;
  conversationId: string;
  content: string;
  /** Regeneration: the assistant message this reply replaces. */
  parentId?: string | undefined;
  /** Set when regenerating — the placeholder already exists. */
  existingAssistantId?: string | undefined;
}

/**
 * The streaming turn (docs/05-rag-and-chat.md §7).
 *
 * Every step below is numbered against the doc's lifecycle. The service still
 * performs **no retrieval of its own** — it calls `retrievalService.retrieve()`
 * and consumes the bundle — and it still owns no SQL and imports no provider
 * module beyond the `LLMProvider` interface.
 *
 * The whole function is written so that **every exit path finalizes the
 * assistant message**. §7 is explicit about why: "Step 3 is a transaction and
 * step 11 persists partial output — together these are what make the stream
 * crash-safe. A design that only writes the assistant message on successful
 * completion loses everything on a disconnect and leaves the thread with a
 * user turn and no reply."
 */
export async function streamTurn(input: StreamTurnInput, sse: SseWriter): Promise<void> {
  const conversation = await conversationRepository.findById(input.conversationId, input.userId);
  if (conversation === null) throw new NotFoundError('That conversation does not exist.');

  const log = logger.child({
    userId: input.userId,
    conversationId: input.conversationId,
    // Never the question: docs/03-backend.md §6 treats user content as secret.
    questionLength: input.content.length,
  });

  // ── Step 3: both rows, one transaction ──────────────────────────────────
  const { userMessage, assistantMessage } = await openTurn(input);

  // ── Step 4: open the stream, register the controller ────────────────────
  const controller = new AbortController();
  const unregister = abortRegistry.register(input.conversationId, controller);

  /*
    A hard ceiling on the whole generation.

    A provider that accepts the connection and then goes quiet would otherwise
    hold the stream, the placeholder, and the registry entry open indefinitely.
    Timing out takes the same path as the stop button, so the user gets a
    partial answer rather than a spinner that never resolves.
  */
  const timeout = setTimeout(() => controller.abort(), env.STREAM_TIMEOUT);
  timeout.unref();

  /*
    The `close` listener from docs/03-backend.md §8: "a `close` listener on the
    request that aborts the provider call so a user who navigates away stops
    incurring generation cost immediately."

    Registered on the writer's response, and the reason it matters is money:
    without it a user who closes the tab keeps paying for tokens nobody will
    read, for as long as the model keeps producing them.
  */
  sse.onClientDisconnect(() => {
    log.info({}, 'Client disconnected — aborting generation');
    controller.abort();
  });

  const startedAt = Date.now();
  /** Everything emitted so far. This is what gets persisted on an abort. */
  let accumulated = '';
  let sources: EvidenceChunkDto[] = [];

  try {
    // ── Step 5 ────────────────────────────────────────────────────────────
    sse.emit('status', { phase: 'retrieving' });

    /*
      ── Step 6: retrieval ───────────────────────────────────────────────────

      Unchanged from M5 except for the scope. A conversation with no Knowledge
      Base passes `undefined` and takes exactly the path it always has; a
      scoped one passes the document ids resolved from its base. `[]` — an
      empty Knowledge Base — is a real value meaning "nothing is in scope", and
      must not be collapsed into `undefined` (docs/07 §6.3).
    */
    const bundle = await retrievalService.retrieve({
      userId: input.userId,
      query: input.content,
      documentIds: await chatService.scopeFor(input.conversationId, input.userId),
    });

    if (controller.signal.aborted) {
      await finalizeStopped(assistantMessage, input.userId, accumulated, startedAt, sse, log);
      return;
    }

    // ── Step 7: abstain without calling the model ─────────────────────────
    if (bundle.abstain) {
      const answer =
        bundle.abstainReason === 'empty-corpus' ? EMPTY_CORPUS_MESSAGE : ABSTENTION_MESSAGE;

      /*
        The abstention is streamed rather than sent whole.

        Not theatre: the client has one code path for rendering an answer, and
        a response that arrives by a different mechanism is a second path that
        drifts. It also keeps the perceived behaviour uniform — an abstention
        should not feel like a different kind of failure.
      */
      sse.emit('sources', { sources: [] });
      sse.emit('status', { phase: 'generating' });
      sse.emit('token', { text: answer });

      const finalized = await messageRepository.finalize(assistantMessage.id, input.userId, {
        content: answer,
        status: 'complete',
        latencyMs: Date.now() - startedAt,
        finishReason: 'abstained',
      });

      log.info({ reason: bundle.abstainReason }, 'Turn abstained without calling the model');

      sse.emit('done', {
        messageId: assistantMessage.id,
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: 'abstained',
        message: toWireMessage(finalized ?? assistantMessage, []),
      });

      /*
        An abstained turn still names its conversation.

        The question was asked, and the sidebar is navigation now
        (docs/00-product.md FR-21) — a thread that answered "no documents yet"
        is exactly the one a new user has most of, and leaving every one of
        them called "New conversation" makes the list useless on the account
        that needs it most. Deterministic, so this branch keeps its promise
        not to call the model.
      */
      await emitTitle(input, sse, log, { useModel: false });
      return;
    }

    // ── Step 5b/8: sources, before any token ──────────────────────────────
    const history = await chatService.historyFor(
      input.conversationId,
      input.userId,
      userMessage.sequence,
    );

    const prompt = buildPrompt(
      {
        question: input.content,
        chunks: bundle.chunks,
        history,
        summary: conversation.summary,
      },
      llmProvider,
    );

    sources = prompt.sources;

    /*
      §8: "`sources` is sent **before** the first token deliberately: the UI can
      render the source list while the model is still writing, which removes the
      perception of a stall during the slowest part of the request."
    */
    sse.emit('status', { phase: 'retrieving', sourceCount: sources.length });
    sse.emit('sources', { sources: sources.map(toWireSource) });

    // ── Step 9 ────────────────────────────────────────────────────────────
    sse.emit('status', { phase: 'generating' });

    // ── Step 10: stream tokens ────────────────────────────────────────────
    let usage = { promptTokens: 0, completionTokens: 0 };
    let finishReason = 'stop';

    for await (const chunk of llmProvider.stream(
      {
        messages: prompt.messages,
        temperature: env.LLM_TEMPERATURE,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      },
      controller.signal,
    )) {
      if (chunk.type === 'token') {
        accumulated += chunk.text;
        // Backpressure-aware: a client reading slower than the model produces
        // must not accumulate in process memory.
        await sse.emitWithBackpressure('token', { text: chunk.text });
        continue;
      }

      usage = chunk.usage;
      finishReason = chunk.finishReason;
    }

    // ── Step 11: abort — persist the partial answer ───────────────────────
    if (controller.signal.aborted || finishReason === 'aborted') {
      await finalizeStopped(assistantMessage, input.userId, accumulated, startedAt, sse, log, sources);
      return;
    }

    // ── Step 12: validate citations, persist ──────────────────────────────
    const mapped = mapCitations(accumulated, sources);

    if (mapped.invalidMarkers.length > 0) {
      log.warn({ invalidMarkers: mapped.invalidMarkers }, 'Model cited a source that does not exist');
    }

    const finalized = await db.transaction().execute(async (trx) => {
      const message = await messageRepository.finalize(
        assistantMessage.id,
        input.userId,
        {
          content: mapped.content,
          status: 'complete',
          model: llmProvider.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          latencyMs: Date.now() - startedAt,
          finishReason,
        },
        trx,
      );

      await citationRepository.createMany(assistantMessage.id, mapped.citations, trx);
      return message;
    });

    await usageRepository
      .record({
        userId: input.userId,
        kind: 'completion',
        model: llmProvider.model,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'Usage event not recorded');
      });

    for (const citation of mapped.citations) {
      sse.emit('citation', buildCitation(citation, sources));
    }

    log.info(
      {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        citations: mapped.citations.length,
        latencyMs: Date.now() - startedAt,
        finishReason,
      },
      'Stream complete',
    );

    sse.emit('done', {
      messageId: assistantMessage.id,
      usage,
      finishReason,
      message: toWireMessage(finalized ?? assistantMessage, mapped.citations, sources),
    });

    // ── Step 13: titling, after the answer, never blocking it ─────────────
    await emitTitle(input, sse, log);
  } catch (error) {
    /*
      An abort surfaces as a thrown error from some providers rather than as a
      clean end of iteration, so it is checked before anything is called a
      failure. Persisting `failed` for a user who pressed stop would show them
      an error for something they chose.
    */
    if (controller.signal.aborted) {
      await finalizeStopped(assistantMessage, input.userId, accumulated, startedAt, sse, log, sources);
      return;
    }

    // ── Step 14: provider error ───────────────────────────────────────────
    const upstream = error instanceof ProviderError;
    const code = upstream ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR';

    /*
      Whatever arrived before the failure is kept, not discarded.

      docs/00-product.md §8.3: "Error, network dropped mid-stream: partial text
      is kept, an inline notice appears, Retry re-requests from the last user
      message." Throwing the tokens away would lose an answer that may have
      been most of the way finished.
    */
    await messageRepository.finalize(assistantMessage.id, input.userId, {
      content: accumulated,
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      errorCode: code,
    });

    log.error({ err: error, code }, 'Stream failed');

    sse.emit('error', {
      code,
      // The provider's own message is never forwarded: upstream errors
      // routinely echo request contents and internal endpoints.
      message: 'The model could not finish that answer. Try again.',
    });
  } finally {
    clearTimeout(timeout);
    unregister();
    sse.close();
  }
}

/**
 * Step 3, or its regeneration equivalent.
 *
 * Regenerating reuses the existing user turn and adds only a new assistant
 * placeholder (§7: "creates a new assistant message with `parent_id` pointing
 * at the replaced one rather than mutating in place").
 */
async function openTurn(
  input: StreamTurnInput,
): Promise<{ userMessage: Message; assistantMessage: Message }> {
  if (input.existingAssistantId !== undefined) {
    const userMessage = await messageRepository.findById(input.existingAssistantId, input.userId);
    if (userMessage === null) throw new NotFoundError('That message does not exist.');

    const assistantMessage = await messageRepository.appendAssistantPlaceholder({
      conversationId: input.conversationId,
      userId: input.userId,
      parentId: input.parentId ?? input.existingAssistantId,
    });

    return { userMessage, assistantMessage };
  }

  return db.transaction().execute(async (trx) => {
    const turn = await messageRepository.appendTurn(
      {
        conversationId: input.conversationId,
        userId: input.userId,
        question: input.content,
        parentId: input.parentId ?? null,
      },
      trx,
    );

    await conversationRepository.recordActivity(input.conversationId, input.userId, 2, trx);
    return turn;
  });
}

/**
 * Step 11 — the stop path, reached by the button, a disconnect, or a timeout.
 *
 * All three converge here because all three mean the same thing to the data:
 * the user is not going to receive any more of this answer, and what did
 * arrive is worth keeping. §7 requires exactly one behaviour for all of them,
 * and both stop paths being "idempotent" falls out of `finalize` refusing to
 * rewrite a terminal status.
 */
async function finalizeStopped(
  assistantMessage: Message,
  userId: string,
  accumulated: string,
  startedAt: number,
  sse: SseWriter,
  log: Logger,
  sources: EvidenceChunkDto[] = [],
): Promise<void> {
  /*
    Citations are still mapped for the partial text.

    A stopped answer that got as far as "[1]" should show that citation — the
    marker is in the text the user can see, and leaving it unresolved renders
    a dead chip, which §5 calls worse than no citation.
  */
  const mapped = mapCitations(accumulated, sources);

  const finalized = await messageRepository.finalize(assistantMessage.id, userId, {
    content: mapped.content,
    status: 'stopped',
    model: llmProvider.model,
    latencyMs: Date.now() - startedAt,
    finishReason: 'aborted',
  });

  if (mapped.citations.length > 0) {
    await citationRepository.createMany(assistantMessage.id, mapped.citations);
  }

  log.info({ characters: mapped.content.length }, 'Generation stopped — partial answer persisted');

  sse.emit('done', {
    messageId: assistantMessage.id,
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: 'aborted',
    message: toWireMessage(finalized ?? assistantMessage, mapped.citations, sources),
  });
}

/** Step 13. Never allowed to affect the answer the user already has. */
async function emitTitle(
  input: StreamTurnInput,
  sse: SseWriter,
  log: Logger,
  options: { useModel?: boolean } = {},
): Promise<void> {
  try {
    await chatService.maybeTitle(input.conversationId, input.userId, input.content, options);

    const conversation = await conversationRepository.findById(input.conversationId, input.userId);
    if (conversation?.titleGenerated !== true) return;

    sse.emit('title', { conversationId: input.conversationId, title: conversation.title });
  } catch (error) {
    log.warn({ err: error }, 'Titling failed — conversation keeps its default name');
  }
}

function toWireSource(chunk: EvidenceChunkDto, index: number): TurnSourceDto {
  return {
    // The prompt's numbering, which is also the UI's (§4.2).
    index: index + 1,
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    text: chunk.text,
    pageNumber: chunk.pageNumber,
    sectionPath: chunk.sectionPath,
    score: chunk.score,
  };
}

/** Projects a mapped citation onto the wire contract, resolving its locator. */
function buildCitation(citation: MappedCitation, sources: EvidenceChunkDto[]) {
  const source = sources.find((entry) => entry.chunkId === citation.chunkId);

  return {
    citationIndex: citation.citationIndex,
    chunkId: citation.chunkId,
    documentId: citation.documentId,
    documentTitle: source?.documentTitle ?? null,
    pageNumber: source?.pageNumber ?? null,
    sectionPath: source?.sectionPath ?? null,
    score: citation.score,
    contentSnapshot: citation.contentSnapshot,
  };
}

/** Projects a row plus its citations onto the wire contract. */
function toWireMessage(
  message: Message,
  citations: MappedCitation[],
  sources: EvidenceChunkDto[] = [],
) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    sequence: message.sequence,
    parentId: message.parentId,
    model: message.model,
    errorCode: message.errorCode,
    finishReason: message.finishReason,
    citations: citations.map((citation) => buildCitation(citation, sources)),
    createdAt: message.createdAt.toISOString(),
  };
}
