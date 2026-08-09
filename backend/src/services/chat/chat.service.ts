import type { EvidenceBundleDto } from '@lumora/shared';
import { env } from '../../config/index.js';
import { NotFoundError, ProviderError as UpstreamError } from '../../domain/errors/index.js';
import { db } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { llmProvider } from '../../providers/llm/llm.factory.js';
import { ProviderError } from '../../providers/llm/llm-provider.interface.js';
import { citationRepository } from '../../repositories/citation.repository.js';
import { conversationRepository } from '../../repositories/conversation.repository.js';
import { messageRepository, type Message } from '../../repositories/message.repository.js';
import { usageRepository } from '../../repositories/usage.repository.js';
import { retrievalService } from '../../services/retrieval/retrieval.service.js';
import { mapCitations, isUncited, type MappedCitation } from './citation.mapper.js';
import { buildPrompt, type HistoryTurn } from './prompt.builder.js';
import {
  ABSTENTION_MESSAGE,
  EMPTY_CORPUS_MESSAGE,
  TITLE_PROMPT,
} from './system-prompt.js';

export interface SendMessageInput {
  userId: string;
  conversationId: string;
  content: string;
  /** Regeneration: the assistant message this reply replaces. */
  parentId?: string | undefined;
}

export interface TurnResult {
  userMessage: Message;
  assistantMessage: Message;
  citations: MappedCitation[];
  /** The evidence the answer was built from — the UI's sources panel. */
  sources: EvidenceBundleDto['chunks'];
  abstained: boolean;
}

/**
 * The chat orchestrator (docs/05-rag-and-chat.md §7).
 *
 * **This service performs no retrieval of its own.** It calls
 * `retrievalService.retrieve()` and consumes the evidence bundle — the seam M5
 * was built to provide. It owns no SQL and imports no provider module, only
 * the `LLMProvider` interface (§6: "Services depend on the interface and never
 * import a provider module").
 *
 * The turn lifecycle below is §7's, minus the streaming steps. Steps 4, 8–11
 * and 13's emission belong to the SSE orchestrator; everything that decides
 * *what* the answer is lives here, where it can be tested without a socket.
 */
export const chatService = {
  /**
   * Runs one complete turn, non-streaming.
   *
   * ```
   * 1 verify ownership
   * 2 TRANSACTION: user message + assistant placeholder
   * 3 retrieve                                   ← M5, unchanged
   * 4 abstain if the bundle is empty             ← never calls the model
   * 5 build prompt                               ← §4.1 budget, §4.2 structure
   * 6 complete
   * 7 validate citations, persist, record usage
   * 8 title, fire-and-forget
   * ```
   */
  async sendMessage(input: SendMessageInput): Promise<TurnResult> {
    const conversation = await conversationRepository.findById(input.conversationId, input.userId);
    if (conversation === null) throw new NotFoundError('That conversation does not exist.');

    const log = logger.child({
      userId: input.userId,
      conversationId: input.conversationId,
      // Never the question itself: docs/03-backend.md §6 treats user content as
      // a secret, and a question about a private document is exactly that.
      questionLength: input.content.length,
    });

    /*
      Step 3 of §7, and it is a transaction on purpose.

      "A design that only writes the assistant message on successful completion
      loses everything on a disconnect and leaves the thread with a user turn
      and no reply, which is both a data bug and a visible product defect."
    */
    const { userMessage, assistantMessage } = await db.transaction().execute(async (trx) => {
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

    const startedAt = Date.now();

    const bundle = await retrievalService.retrieve({
      userId: input.userId,
      query: input.content,
    });

    /*
      Abstention short-circuits **before** the model (§3.3).

      "Not calling the model is strictly better than asking it not to answer —
      it is faster, free, and cannot be talked out of abstaining by a
      persuasive-sounding question." The decision was already made by
      retrieval; this honours it rather than re-deciding.
    */
    if (bundle.abstain) {
      const message =
        bundle.abstainReason === 'empty-corpus' ? EMPTY_CORPUS_MESSAGE : ABSTENTION_MESSAGE;

      const finalized = await messageRepository.finalize(assistantMessage.id, input.userId, {
        content: message,
        status: 'complete',
        latencyMs: Date.now() - startedAt,
        finishReason: 'abstained',
      });

      log.info({ reason: bundle.abstainReason }, 'Turn abstained without calling the model');

      return {
        userMessage,
        assistantMessage: finalized ?? assistantMessage,
        citations: [],
        sources: [],
        abstained: true,
      };
    }

    const history = await this.historyFor(
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

    try {
      const completion = await llmProvider.complete({
        messages: prompt.messages,
        temperature: env.LLM_TEMPERATURE,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      });

      /*
        Citations are validated against the sources that were actually in the
        prompt, in prompt order (§5 defence 3). `prompt.sources` rather than
        `bundle.chunks`: the builder may have dropped a chunk for budget and
        reordered the rest for attention, so the model's `[2]` means the second
        source *it saw*.
      */
      const mapped = mapCitations(completion.content, prompt.sources);

      if (mapped.invalidMarkers.length > 0) {
        // A quality signal, not an error — the markers are already stripped.
        log.warn({ invalidMarkers: mapped.invalidMarkers }, 'Model cited a source that does not exist');
      }
      if (isUncited(mapped, prompt.sources)) {
        log.warn({ sources: prompt.sources.length }, 'Answer cited no sources despite having some');
      }

      const finalized = await db.transaction().execute(async (trx) => {
        const message = await messageRepository.finalize(
          assistantMessage.id,
          input.userId,
          {
            content: mapped.content,
            status: 'complete',
            model: llmProvider.model,
            promptTokens: completion.usage.promptTokens,
            completionTokens: completion.usage.completionTokens,
            latencyMs: Date.now() - startedAt,
            finishReason: completion.finishReason,
          },
          trx,
        );

        await citationRepository.createMany(assistantMessage.id, mapped.citations, trx);

        return message;
      });

      // Usage outside the transaction: a ledger write must never be able to
      // roll back an answer the user already has.
      await usageRepository
        .record({
          userId: input.userId,
          kind: 'completion',
          model: llmProvider.model,
          inputTokens: completion.usage.promptTokens,
          outputTokens: completion.usage.completionTokens,
        })
        .catch((error: unknown) => {
          log.error({ err: error }, 'Usage event not recorded');
        });

      log.info(
        {
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          citations: mapped.citations.length,
          sources: prompt.sources.length,
          droppedChunks: prompt.dropped.chunks,
          droppedTurns: prompt.dropped.turns,
          latencyMs: Date.now() - startedAt,
          finishReason: completion.finishReason,
        },
        'Turn complete',
      );

      // Fire-and-forget (§7 step 13): "a titling failure must never fail a turn
      // that already produced a good answer."
      void this.maybeTitle(input.conversationId, input.userId, input.content);

      return {
        userMessage,
        assistantMessage: finalized ?? assistantMessage,
        citations: mapped.citations,
        sources: prompt.sources,
        abstained: false,
      };
    } catch (error) {
      /*
        §7 step 14: persist `failed` with the error code.

        The placeholder is filled in rather than deleted, so the thread shows
        what happened and the client has a message id to retry against. A
        vanished row would leave a question with no reply and nothing to act
        on.
      */
      const upstream = error instanceof ProviderError;
      const code = upstream ? 'PROVIDER_ERROR' : 'INTERNAL_ERROR';

      await messageRepository.finalize(assistantMessage.id, input.userId, {
        content: '',
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
      });

      log.error({ err: error, code }, 'Turn failed');

      /*
        Translated at the service boundary, deliberately.

        The provider layer's `ProviderError` is a transport concern and knows
        nothing about HTTP — docs/03-backend.md §1 keeps providers ignorant of
        Lumora's domain. The domain's `ProviderError` is the one the error
        handler maps to 502, and a model outage is a bad gateway, not an
        internal error: the distinction tells the client whether retrying is
        worth anything.
      */
      if (upstream) {
        throw new UpstreamError(llmProvider.name, undefined, error);
      }

      throw error;
    }
  },

  /**
   * The recent turns for the prompt's history block (§4.4).
   *
   * Bounded to sequences **before** the current turn. Both of this turn's rows
   * already exist by the time this runs (§7 step 3) — the question with its
   * text, the placeholder with none — and including either would put the
   * question in the prompt twice or a blank assistant turn between the history
   * and the question.
   */
  async historyFor(
    conversationId: string,
    userId: string,
    currentSequence: number,
  ): Promise<HistoryTurn[]> {
    // Two rows per turn, so the turn count doubles into a message count.
    const messages = await messageRepository.recentHistory(
      conversationId,
      userId,
      env.CHAT_CONTEXT_LIMIT * 2,
      currentSequence,
    );

    return messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: message.content,
      }));
  },

  /**
   * Names an untitled conversation from its first question (§7 step 13).
   *
   * Every failure path is swallowed: the guard is `title_generated = false` in
   * SQL, the model call is best-effort, and a bad title is discarded rather
   * than saved. None of it may affect the answer the user is already reading.
   */
  async maybeTitle(conversationId: string, userId: string, question: string): Promise<void> {
    try {
      const conversation = await conversationRepository.findById(conversationId, userId);
      if (conversation === null || conversation.titleGenerated) return;

      const completion = await llmProvider.complete({
        messages: [
          { role: 'system', content: TITLE_PROMPT },
          { role: 'user', content: question.slice(0, 500) },
        ],
        temperature: 0,
        // A six-word title cannot need more, and a low ceiling is what stops a
        // chatty model billing for a paragraph.
        maxOutputTokens: 24,
      });

      const title = cleanTitle(completion.content);
      if (title.length === 0) return;

      await conversationRepository.setGeneratedTitle(conversationId, userId, title);
    } catch (error) {
      logger.warn({ err: error, conversationId }, 'Titling failed — conversation keeps its default name');
    }
  },
};

/**
 * Makes a model's reply safe to put in a sidebar row.
 *
 * Models wrap titles in quotes, add trailing periods, and occasionally answer
 * with a sentence despite the instruction. Each is cheap to strip and none is
 * worth a retry.
 */
export function cleanTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();

  const unquoted = collapsed.replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.。]+$/, '');

  // Hard cap in characters as well as words: six long words still overflow the
  // row, and the sidebar truncates with an ellipsis that hides the difference.
  const words = unquoted.split(' ').slice(0, 6).join(' ');

  return words.length > 60 ? `${words.slice(0, 57).trimEnd()}…` : words;
}
