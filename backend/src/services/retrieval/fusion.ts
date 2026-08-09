import { RRF_K } from '@lumora/shared';
import type { RetrievalSource } from '@lumora/shared';
import type { RetrievedChunk } from './retriever.interface.js';

/** One retriever's ranked output, labelled with which retriever produced it. */
export interface RankedList {
  source: 'vector' | 'bm25';
  chunks: RetrievedChunk[];
}

/** A chunk after fusion, carrying where it came from and how it ranked. */
export interface FusedChunk extends RetrievedChunk {
  /** The RRF score. Comparable only within one fused set. */
  score: number;
  source: RetrievalSource;
  vectorRank: number | null;
  vectorScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
}

/**
 * Reciprocal Rank Fusion (docs/05-rag-and-chat.md §3.2).
 *
 * ```
 * score = Σ 1 / (k + rank_i)
 * ```
 *
 * **Why rank and not score.** §3.2: "cosine similarity and `ts_rank_cd` are on
 * incomparable, non-normalized scales; blending them requires a magic weight
 * that has to be retuned whenever either component changes. RRF uses only rank
 * ordering, so it needs no calibration and no tuning." Nothing in this function
 * reads a retriever's score for ranking purposes — the per-retriever scores
 * are carried through for debugging and for the relevance floor, and never
 * summed.
 *
 * **Why the constant damps the top.** With `k = 60`, rank 1 contributes
 * `1/61 ≈ 0.0164` and rank 2 `1/62 ≈ 0.0161` — nearly equal. A chunk both
 * retrievers rank 2nd (`0.0323`) therefore beats one that a single retriever
 * ranks 1st (`0.0164`). That is the intended behaviour: agreement between two
 * independent methods is stronger evidence than one method's confidence, which
 * is the whole argument for hybrid search.
 *
 * Deterministic: ties break on `chunkId`, so the same inputs always produce
 * the same order regardless of what order the retrievers finished in.
 */
export function reciprocalRankFusion(lists: RankedList[], k: number = RRF_K): FusedChunk[] {
  const fused = new Map<string, FusedChunk>();

  for (const list of lists) {
    list.chunks.forEach((chunk, index) => {
      // 1-based: rank 0 would make the first result's contribution `1/k`
      // rather than `1/(k+1)`, shifting every score by a constant that is
      // easy to introduce and hard to notice.
      const rank = index + 1;
      const contribution = 1 / (k + rank);

      const existing = fused.get(chunk.chunkId);

      if (existing === undefined) {
        fused.set(chunk.chunkId, {
          ...chunk,
          score: contribution,
          source: list.source,
          vectorRank: list.source === 'vector' ? rank : null,
          vectorScore: list.source === 'vector' ? chunk.score : null,
          lexicalRank: list.source === 'bm25' ? rank : null,
          lexicalScore: list.source === 'bm25' ? chunk.score : null,
        });
        return;
      }

      /*
        Seen by another retriever too — this is the duplicate removal the
        milestone asks for, and it is where a chunk earns `hybrid`.

        The scores add rather than replace: `Σ` in the formula is over every
        list the chunk appears in, and a chunk found twice must outrank the
        same chunk found once.
      */
      existing.score += contribution;
      existing.source = 'hybrid';

      if (list.source === 'vector') {
        existing.vectorRank = rank;
        existing.vectorScore = chunk.score;
      } else {
        existing.lexicalRank = rank;
        existing.lexicalScore = chunk.score;
      }
    });
  }

  return [...fused.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
  );
}

/**
 * The relevance floor (docs/05-rag-and-chat.md §3.3).
 *
 * "A minimum semantic similarity below which a chunk is discarded regardless
 * of rank. Rank is relative; a top-ranked chunk in a corpus containing nothing
 * relevant is still irrelevant, and this is exactly how naive RAG
 * hallucinates: it always returns *something*."
 *
 * **An interpretation, stated plainly.** The floor is specified as a *semantic*
 * threshold, but a chunk found only by the lexical half has no semantic score —
 * it was not in the vector top-K, which is not the same as being below the
 * floor. Discarding those would destroy the exact case §3.2 says hybrid search
 * exists for: a product code or section number that embeddings miss entirely
 * and keyword search finds precisely.
 *
 * So the floor is applied where a semantic score exists, and a lexical-only hit
 * is kept on the strength of its own evidence — an exact term match, which is
 * independent of the measure the floor uses. A lexical-only hit is not
 * evidence-free; it is evidence of a different kind.
 */
export function applyRelevanceFloor(chunks: FusedChunk[], floor: number): FusedChunk[] {
  return chunks.filter((chunk) => chunk.vectorScore === null || chunk.vectorScore >= floor);
}

/**
 * Caps how many chunks any one document may contribute
 * (§3.3: "cap chunks per document (default 3)").
 *
 * "So one long, verbose document cannot monopolize the context and starve a
 * more relevant passage in another file." A fifty-page manual will always have
 * more near-miss passages than a two-page memo, and without a cap it wins the
 * whole context window on volume rather than on relevance.
 *
 * Order is preserved, so the chunks a document does contribute are its best.
 */
export function capPerDocument(chunks: FusedChunk[], maxPerDocument: number): FusedChunk[] {
  const seen = new Map<string, number>();
  const kept: FusedChunk[] = [];

  for (const chunk of chunks) {
    const used = seen.get(chunk.documentId) ?? 0;
    if (used >= maxPerDocument) continue;

    seen.set(chunk.documentId, used + 1);
    kept.push(chunk);
  }

  return kept;
}
