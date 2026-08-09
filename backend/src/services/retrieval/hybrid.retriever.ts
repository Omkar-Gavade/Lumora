import {
  FUSION_TOP_K,
  LEXICAL_TOP_K,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_RESULTS,
  RRF_K,
  VECTOR_TOP_K,
} from '@lumora/shared';
import { env } from '../../config/index.js';
import type { Logger } from '../../lib/logger.js';
import {
  applyRelevanceFloor,
  capPerDocument,
  reciprocalRankFusion,
  type FusedChunk,
} from './fusion.js';
import { NoopReranker, type Reranker } from './reranker.js';
import type { RetrievalQuery, RetrievedChunk, Retriever } from './retriever.interface.js';

export interface HybridOptions {
  vectorTopK?: number;
  lexicalTopK?: number;
  fusionTopK?: number;
  rrfK?: number;
  relevanceFloor?: number;
  maxPerDocument?: number;
  maxResults?: number;
}

export interface HybridResult {
  chunks: FusedChunk[];
  stats: {
    vectorCandidates: number;
    lexicalCandidates: number;
    fusedCandidates: number;
  };
  timings: { vectorMs: number; lexicalMs: number; fusionMs: number };
}

/**
 * Hybrid search: two retrievers, fused (docs/05-rag-and-chat.md §3.2–3.3).
 *
 * The pipeline in one place, so the ordering of its stages is a fact in one
 * file rather than an emergent property of several:
 *
 * ```
 * vector(k=20) ⋓ bm25(k=20) → RRF → top 12 → rerank → floor → per-doc cap → K≤6
 * ```
 *
 * **Every stage boundary is deliberate.** Reranking runs on the full fused set,
 * before the floor and the cap, because a reranker that saw an
 * already-narrowed list would be reordering someone else's selection. The
 * floor runs before the cap so a document is not credited with slots for
 * chunks that were about to be discarded. The cap runs before the final K so
 * diversity is enforced on the candidates that survive rather than on the six
 * that happen to be left.
 */
export class HybridRetriever {
  private readonly reranker: Reranker;

  constructor(
    private readonly vector: Retriever,
    private readonly lexical: Retriever,
    reranker: Reranker = new NoopReranker(),
  ) {
    this.reranker = reranker;
  }

  async retrieve(
    query: RetrievalQuery,
    log: Logger,
    options: HybridOptions = {},
  ): Promise<HybridResult> {
    const vectorTopK = options.vectorTopK ?? VECTOR_TOP_K;
    const lexicalTopK = options.lexicalTopK ?? LEXICAL_TOP_K;

    /*
      Both retrievers run concurrently.

      They share nothing — different backends, different scales, no ordering
      dependency — so the wall-clock cost of hybrid search is the slower half
      rather than the sum. Sequential execution here would make the documented
      "costs one extra Postgres query" (§3.2) cost a round trip of latency
      instead.

      `allSettled`, not `all`: if the vector store is down, lexical results are
      still worth returning. Degrading to one retriever is a worse answer;
      failing the whole query is no answer at all.
    */
    const vectorStarted = Date.now();
    const [vectorOutcome, lexicalOutcome] = await Promise.allSettled([
      this.vector.retrieve({ ...query, topK: vectorTopK }),
      this.lexical.retrieve({ ...query, topK: lexicalTopK }),
    ]);
    const searchMs = Date.now() - vectorStarted;

    const vectorChunks = unwrap(vectorOutcome, 'vector', log);
    const lexicalChunks = unwrap(lexicalOutcome, 'bm25', log);

    const fusionStarted = Date.now();

    const fused = reciprocalRankFusion(
      [
        { source: 'vector', chunks: vectorChunks },
        { source: 'bm25', chunks: lexicalChunks },
      ],
      options.rrfK ?? RRF_K,
    ).slice(0, options.fusionTopK ?? FUSION_TOP_K);

    const reranked = await this.reranker.rerank(query.text, fused);

    const survived = applyRelevanceFloor(
      reranked,
      options.relevanceFloor ?? env.RETRIEVAL_MIN_SCORE,
    );

    const capped = capPerDocument(
      survived,
      options.maxPerDocument ?? MAX_CHUNKS_PER_DOCUMENT,
    ).slice(0, options.maxResults ?? MAX_RESULTS);

    const fusionMs = Date.now() - fusionStarted;

    return {
      chunks: capped,
      stats: {
        vectorCandidates: vectorChunks.length,
        lexicalCandidates: lexicalChunks.length,
        fusedCandidates: fused.length,
      },
      /*
        The two searches ran concurrently, so neither has a wall-clock duration
        of its own — both are reported as the elapsed time of the pair. Timing
        them individually would need them run in sequence, which would be
        measuring a slower system than the one that ships.
      */
      timings: { vectorMs: searchMs, lexicalMs: searchMs, fusionMs },
    };
  }
}

/**
 * Takes one retriever's results, or degrades to none.
 *
 * Logged at `error` because a half-dead hybrid search is exactly the condition
 * that produces quietly worse answers: results still come back, they are just
 * missing the half that would have found the exact identifier. Nothing else
 * will crash to draw attention to it.
 */
function unwrap(
  outcome: PromiseSettledResult<RetrievedChunk[]>,
  source: string,
  log: Logger,
): RetrievedChunk[] {
  if (outcome.status === 'fulfilled') return outcome.value;

  log.error({ err: outcome.reason, retriever: source }, 'Retriever failed — degrading to the other half');
  return [];
}
