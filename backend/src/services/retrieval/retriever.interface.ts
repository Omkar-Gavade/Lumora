/**
 * One chunk as a retriever found it, before fusion.
 *
 * Carries everything a citation needs so that fusion — and everything after
 * it — never has to go back to the database. docs/05-rag-and-chat.md §2.5
 * stores exactly this alongside each vector for the same reason: "enough for
 * the UI to render a citation without a second database round trip on the hot
 * path".
 */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  chunkIndex: number;
  tokenCount: number;
  pageNumber: number | null;
  sectionPath: string | null;
  /**
   * The retriever's own score, on its own scale.
   *
   * Cosine similarity for the vector half, `ts_rank_cd` for the lexical half.
   * **Never compared across retrievers** — §3.2 chose RRF precisely because
   * these two scales are incomparable and blending them needs a magic weight
   * that must be retuned whenever either component changes.
   */
  score: number;
}

/** What a retriever is asked for. */
export interface RetrievalQuery {
  /** The normalized query text. */
  text: string;
  /** Tenant scope. Never optional, never client-supplied. */
  userId: string;
  topK: number;
  /** Restrict to these documents. `undefined` or empty means the whole corpus. */
  documentIds?: string[] | undefined;
}

/**
 * One way of finding chunks (docs/05-rag-and-chat.md §3.2).
 *
 * The interface exists so `HybridRetriever` composes retrievers rather than
 * knowing about Chroma and Postgres, and so each half can be tested in
 * isolation against the property it is responsible for. It is also the seam a
 * third retriever would arrive through — the fusion step takes a list, not a
 * pair.
 *
 * Results are returned **ranked, best first**, because RRF consumes rank and
 * not score. A retriever that returned an unordered set would silently
 * produce meaningless fusion input.
 */
export interface Retriever {
  /** Which half this is, for `RetrievalSource` attribution and for logs. */
  readonly name: 'vector' | 'bm25';

  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}

/**
 * Orders results so identical inputs always produce identical output.
 *
 * Score descending, then `chunkId` ascending. The tiebreak is the point: both
 * Chroma and Postgres are free to return equal-scoring rows in any order, and
 * without a deterministic tiebreak a rerun can reorder ties — which changes
 * ranks, which changes RRF scores, which changes the final set. "Deterministic
 * ordering" has to be imposed here; it is not something either backend
 * promises.
 */
export function rankDeterministically(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return [...chunks].sort(
    (left, right) =>
      right.score - left.score || (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
  );
}

/**
 * Removes repeated chunk ids, keeping the best-scoring occurrence.
 *
 * A single retriever should not return a chunk twice, but "should not" is not
 * "cannot": a vector store holding a stale duplicate under a different id, or
 * a lexical query joined against a document row that appears twice, both
 * produce it. Deduplicating at the retriever boundary means fusion can assume
 * uniqueness rather than defending against it.
 */
export function dedupeByChunkId(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();

  for (const chunk of chunks) {
    const existing = best.get(chunk.chunkId);
    if (existing === undefined || chunk.score > existing.score) best.set(chunk.chunkId, chunk);
  }

  return [...best.values()];
}
