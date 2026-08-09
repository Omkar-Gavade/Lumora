/**
 * Retrieval limits, shared so the search box and the API agree.
 *
 * Every number here is from docs/05-rag-and-chat.md §3 and is load-bearing —
 * see the justification beside each. They are constants rather than magic
 * numbers at the call site precisely because §3.2 argues that RRF was chosen
 * to *avoid* tunable weights; the few numbers that remain deserve to be
 * visible and explained in one place.
 */

/** §3.2: "embed the rewritten query, `k=20` from the user's collection". */
export const VECTOR_TOP_K = 20;

/** §3.2: "Postgres full-text over `content_tsv`, ranked with `ts_rank_cd`, `k=20`". */
export const LEXICAL_TOP_K = 20;

/**
 * §3.2: `score = Σ 1 / (60 + rank_i)`.
 *
 * 60 is the constant from the original RRF paper and is not a tuning knob —
 * it damps the difference between the top few ranks so that a chunk ranked 1st
 * by one retriever and absent from the other does not automatically beat a
 * chunk ranked 2nd and 3rd by both.
 */
export const RRF_K = 60;

/** §3.3: "Take the top 12 fused". */
export const FUSION_TOP_K = 12;

/** §3.3: "cap chunks per document (default 3)". */
export const MAX_CHUNKS_PER_DOCUMENT = 3;

/** §3.3: "Final K ≤ 6". */
export const MAX_RESULTS = 6;

/** §4.1: the retrieved-context allocation of the prompt budget. */
export const CONTEXT_TOKEN_BUDGET = 4_000;

/**
 * Longest accepted query.
 *
 * Bounded because an embedding call is priced per token and a pasted document
 * in the search box is not a question. Generous enough for a real
 * multi-sentence query.
 */
export const MAX_QUERY_LENGTH = 1_000;

/** Shortest query worth running. Below this, ranking is noise. */
export const MIN_QUERY_LENGTH = 2;
