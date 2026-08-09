import type { FusedChunk } from './fusion.js';

/**
 * A reordering stage between fusion and selection
 * (docs/05-rag-and-chat.md §3.4).
 *
 * §3.4 designs a cross-encoder reranker and then defers it: "Deferred because
 * it adds a model dependency and 200–400ms. **The pipeline has an explicit
 * no-op `Reranker` stage so adding one later is registering an implementation,
 * not restructuring retrieval.**"
 *
 * This is that stage. It exists in M5 with no implementation behind it because
 * the point of the seam is *where the call site is*, and a call site added
 * later is a call site placed wherever the change happened to be convenient —
 * typically after the per-document cap, which is wrong: reranking must see the
 * full fused candidate set, or it reranks a list something else already
 * narrowed on a different criterion.
 */
export interface Reranker {
  readonly name: string;

  /**
   * Reorders candidates against the query, best first.
   *
   * Takes the query text because that is what a cross-encoder needs — it scores
   * query and passage jointly rather than comparing two independently-computed
   * vectors, which is the entire reason §3.4 expects it to improve precision.
   * A signature without the query would have to change when a real
   * implementation arrives, which would defeat the seam.
   */
  rerank(query: string, candidates: FusedChunk[]): Promise<FusedChunk[]>;
}

/**
 * The Phase 1 implementation: returns the fused order untouched.
 *
 * Deliberately **not** a stage that can be skipped by a `null` check at the
 * call site. A no-op object means the pipeline has one shape in every
 * configuration, so the day a real reranker is registered nothing above it
 * changes — and the ordering guarantees the tests assert hold identically with
 * either one.
 */
export class NoopReranker implements Reranker {
  readonly name = 'noop';

  rerank(_query: string, candidates: FusedChunk[]): Promise<FusedChunk[]> {
    return Promise.resolve(candidates);
  }
}
