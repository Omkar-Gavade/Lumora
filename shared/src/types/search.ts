/**
 * Which retriever surfaced a chunk.
 *
 * Kept on every result because it is the single most useful debugging signal
 * in the pipeline (docs/06-roadmap.md M4: "'the answer is wrong' is
 * unattributable between retrieval and generation"). A result set that is
 * entirely `vector` on a query containing an exact product code says the
 * lexical half is not doing its job — a diagnosis that is impossible to make
 * from a ranked list alone.
 */
export type RetrievalSource = 'vector' | 'bm25' | 'hybrid';

/**
 * One retrieved passage, with everything a citation needs.
 *
 * The field list is docs/05-rag-and-chat.md §2.5's metadata contract plus the
 * scores that produced the ranking. Nothing here is prompt-shaped: this is
 * evidence, and the chat orchestrator decides how to render it.
 */
export interface EvidenceChunkDto {
  chunkId: string;
  documentId: string;
  /** The document's display filename — what a citation labels the source. */
  documentTitle: string;
  /** The passage exactly as stored. Never the section-path-enriched form. */
  text: string;
  /** `null` for formats without fixed pagination (DOCX, Markdown, plain text). */
  pageNumber: number | null;
  /** `"3. Termination > 3.2 Notice"`, or `null` outside any heading. */
  sectionPath: string | null;
  chunkIndex: number;
  tokenCount: number;

  /** The fused RRF score. Comparable only within one result set. */
  score: number;
  source: RetrievalSource;

  /**
   * Per-retriever detail, for debugging rather than for ranking.
   *
   * Ranks are 1-based and `null` when that retriever did not return the chunk.
   * `vectorScore` is a cosine similarity; `lexicalScore` is `ts_rank_cd`. The
   * two are on incomparable scales — which is exactly why fusion uses ranks
   * (§3.2) — so they are reported side by side rather than combined.
   */
  vectorRank: number | null;
  vectorScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
}

/**
 * Why a bundle came back empty.
 *
 * Distinguished because the three call for different responses. An empty
 * corpus is an onboarding problem, a query that matched nothing is a
 * legitimate abstention, and a query filtered down to nothing is a UI problem
 * with the filter the user set.
 */
export type AbstainReason = 'empty-corpus' | 'no-matches' | 'below-floor';

/**
 * Timings for one retrieval, in milliseconds.
 *
 * Surfaced in the response and not only in logs: the search page exists to
 * validate retrieval, and "which half is slow" is part of what it validates.
 */
export interface RetrievalTimingsDto {
  totalMs: number;
  embedMs: number;
  vectorMs: number;
  lexicalMs: number;
  fusionMs: number;
}

/**
 * The complete output of the retrieval engine.
 *
 * **This is the contract the chat orchestrator consumes, and it is why the
 * orchestrator never retrieves anything itself.** Everything a grounded answer
 * needs — the passages, their provenance, the token cost, and the decision to
 * abstain — is decided here, where it can be tested without a model.
 */
export interface EvidenceBundleDto {
  /** The query after normalization — what actually reached the retrievers. */
  query: string;
  /** The user's original wording, preserved verbatim. */
  originalQuery: string;

  chunks: EvidenceChunkDto[];

  /**
   * Total tokens across `chunks`, against the §4.1 budget.
   *
   * Reported so the orchestrator can assemble a prompt without recounting, and
   * so a bundle that hit the budget is visible rather than silently truncated.
   */
  tokenCount: number;
  tokenBudget: number;

  /**
   * `true` when nothing survived the relevance floor.
   *
   * docs/05-rag-and-chat.md §3.3: the model is not called at all in this case.
   * The decision is made here because it is a retrieval judgement, and because
   * a decision made before the model cannot be argued out of it by a
   * persuasive-sounding question.
   */
  abstain: boolean;
  abstainReason: AbstainReason | null;

  /** How many candidates each stage saw, before and after filtering. */
  stats: {
    vectorCandidates: number;
    lexicalCandidates: number;
    fusedCandidates: number;
    returned: number;
  };

  timings: RetrievalTimingsDto;
}
