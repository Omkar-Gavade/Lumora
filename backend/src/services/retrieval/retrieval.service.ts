import {
  CONTEXT_TOKEN_BUDGET,
  MAX_RESULTS,
  type AbstainReason,
  type EvidenceBundleDto,
} from '@lumora/shared';
import { logger } from '../../lib/logger.js';
import { chunkRepository } from '../../repositories/chunk.repository.js';
import { embeddingProvider } from '../../providers/embedding/embedding.factory.js';
import { vectorStore } from '../../providers/vector/vector.factory.js';
import { Bm25Retriever } from './bm25.retriever.js';
import { buildContext } from './context.builder.js';
import { HybridRetriever, type HybridOptions } from './hybrid.retriever.js';
import { normalizeQuery } from './query.normalizer.js';
import { VectorRetriever } from './vector.retriever.js';

export interface RetrieveInput {
  userId: string;
  query: string;
  topK?: number | undefined;
  documentIds?: string[] | undefined;
}

/**
 * The retrieval engine's single entry point.
 *
 * **The chat orchestrator will call this and nothing else.** Every decision
 * that determines what a grounded answer is allowed to say — which passages,
 * in what order, within what budget, and whether to answer at all — is made
 * here, where it can be tested without a model and changed without touching
 * generation. That separation is the point of the milestone: docs/06-roadmap.md
 * calls the retrieval-only path "the most valuable debugging tool in the
 * project" precisely because it makes "the answer is wrong" attributable.
 */
const hybrid = new HybridRetriever(
  new VectorRetriever(vectorStore, embeddingProvider),
  new Bm25Retriever(),
);

export const retrievalService = {
  async retrieve(input: RetrieveInput, options: HybridOptions = {}): Promise<EvidenceBundleDto> {
    const startedAt = Date.now();

    /*
      The query is normalized, never rewritten.

      docs/05-rag-and-chat.md §3.1's history-aware rewrite is an LLM call that
      needs conversation turns this milestone does not have, and it is used
      *only* for retrieval — the answering model sees the user's original
      wording. Both forms are carried on the bundle so the orchestrator can
      honour that distinction without re-deriving either.
    */
    const { text, original } = normalizeQuery(input.query);

    /*
      One child logger for the whole retrieval, carrying no query text.

      docs/03-backend.md §6 treats content fields as secrets and the redaction
      list already covers them — but a query is the user's question about their
      own documents, and logging it would put private content in an aggregator
      just as surely as logging a chunk would. Length and term count are enough
      to correlate a slow retrieval with an unusual query.
    */
    const log = logger.child({
      userId: input.userId,
      queryLength: text.length,
      queryTerms: text.split(' ').length,
      filtered: (input.documentIds?.length ?? 0) > 0,
    });

    const result = await hybrid.retrieve(
      {
        text,
        userId: input.userId,
        topK: input.topK ?? MAX_RESULTS,
        documentIds: input.documentIds,
      },
      log,
      { ...options, maxResults: input.topK ?? options.maxResults ?? MAX_RESULTS },
    );

    const context = buildContext(result.chunks, { maxResults: input.topK ?? MAX_RESULTS });

    const totalMs = Date.now() - startedAt;

    const abstainReason = await decideAbstention(input.userId, result.stats, context.chunks.length);

    log.info(
      {
        totalMs,
        vectorMs: result.timings.vectorMs,
        lexicalMs: result.timings.lexicalMs,
        fusionMs: result.timings.fusionMs,
        vectorCandidates: result.stats.vectorCandidates,
        lexicalCandidates: result.stats.lexicalCandidates,
        fusedCandidates: result.stats.fusedCandidates,
        returned: context.chunks.length,
        tokenCount: context.tokenCount,
        droppedForBudget: context.droppedForBudget,
        abstain: abstainReason !== null,
        // Absent on a healthy search rather than logged as an empty array, so
        // the field's presence is itself the signal worth alerting on.
        ...(result.stats.degraded.length > 0 ? { degraded: result.stats.degraded } : {}),
      },
      'Retrieval complete',
    );

    return {
      query: text,
      originalQuery: original,
      chunks: context.chunks,
      tokenCount: context.tokenCount,
      tokenBudget: context.tokenBudget,
      abstain: abstainReason !== null,
      abstainReason,
      stats: {
        vectorCandidates: result.stats.vectorCandidates,
        lexicalCandidates: result.stats.lexicalCandidates,
        fusedCandidates: result.stats.fusedCandidates,
        returned: context.chunks.length,
        degraded: result.stats.degraded,
      },
      timings: {
        totalMs,
        // Embedding happens inside the vector retriever, so its cost is part of
        // that half's elapsed time rather than a separately measurable span.
        // Reported as 0 rather than invented: a fabricated number in a
        // debugging tool is worse than an honest absence.
        embedMs: 0,
        vectorMs: result.timings.vectorMs,
        lexicalMs: result.timings.lexicalMs,
        fusionMs: result.timings.fusionMs,
      },
    };
  },
};

/**
 * Decides whether the bundle is an abstention, and why
 * (docs/05-rag-and-chat.md §3.3).
 *
 * The decision is made here rather than by the future chat orchestrator
 * because it is a retrieval judgement: "Not calling the model is strictly
 * better than asking it not to answer — it is faster, free, and cannot be
 * talked out of abstaining by a persuasive-sounding question." A decision
 * carried on the bundle cannot be argued with downstream.
 *
 * The three reasons are distinguished because they call for different
 * responses: an empty corpus is an onboarding problem, a query that matched
 * nothing is a legitimate abstention, and results that existed but were
 * discarded by the floor is the case §3.3 exists to produce.
 */
async function decideAbstention(
  userId: string,
  stats: { fusedCandidates: number },
  returned: number,
): Promise<AbstainReason | null> {
  if (returned > 0) return null;

  // Candidates existed and none survived — the floor, or a budget too small to
  // fit even one chunk. This is the case §3.3 exists to produce.
  if (stats.fusedCandidates > 0) return 'below-floor';

  /*
    Nothing was retrieved. One count query — only on the abstention path, which
    is rare — separates "you have not uploaded anything yet" from "your
    documents do not cover this".

    Worth the round trip because the two produce completely different product
    responses: the first is an onboarding prompt, the second is an honest "I
    don't know". Collapsing them would tell a new user their empty library
    contains no answer to their question.
  */
  const indexed = await chunkRepository.countForUser(userId);

  return indexed === 0 ? 'empty-corpus' : 'no-matches';
}

export { CONTEXT_TOKEN_BUDGET };
