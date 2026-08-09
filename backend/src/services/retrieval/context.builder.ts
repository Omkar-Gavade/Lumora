import { CONTEXT_TOKEN_BUDGET, type EvidenceChunkDto } from '@lumora/shared';
import type { FusedChunk } from './fusion.js';

export interface BuiltContext {
  chunks: EvidenceChunkDto[];
  tokenCount: number;
  tokenBudget: number;
  /** How many candidates were dropped because the budget ran out. */
  droppedForBudget: number;
}

/**
 * Turns ranked candidates into the evidence a prompt will later be built from
 * (docs/05-rag-and-chat.md §4.1).
 *
 * **This is evidence preparation, not prompt assembly.** No system
 * instructions, no source numbering, no delimiters, no ordering tricks — §4.2's
 * "highest-scoring chunks at the beginning and end of the context block" is a
 * prompt-layout decision that belongs to the component that builds the prompt,
 * and applying it here would bake one model's attention characteristics into
 * the retrieval contract.
 *
 * What it does own is the **token budget**. §4.1 allocates ≤4000 tokens to
 * retrieved context and is explicit about how overflow is handled: "dropping
 * the lowest-ranked chunks first … never by truncating mid-chunk, which
 * produces a source that ends mid-clause and a citation that points at a
 * fragment."
 */
export function buildContext(
  candidates: FusedChunk[],
  options: { maxResults: number; tokenBudget?: number } = { maxResults: 6 },
): BuiltContext {
  const budget = options.tokenBudget ?? CONTEXT_TOKEN_BUDGET;

  const chunks: EvidenceChunkDto[] = [];
  let used = 0;
  let dropped = 0;

  for (const candidate of candidates) {
    if (chunks.length >= options.maxResults) {
      dropped += 1;
      continue;
    }

    /*
      A chunk that does not fit is skipped, and the loop continues.

      Not `break`: chunks vary in size, and a single oversized passage early in
      the ranking should not starve three smaller, still-relevant ones behind
      it. Continuing costs nothing — the candidate list is at most a dozen
      entries — and it fills the budget rather than abandoning it.
    */
    if (used + candidate.tokenCount > budget) {
      dropped += 1;
      continue;
    }

    chunks.push(toEvidenceChunk(candidate));
    used += candidate.tokenCount;
  }

  return { chunks, tokenCount: used, tokenBudget: budget, droppedForBudget: dropped };
}

/**
 * Projects a fused candidate onto the wire contract.
 *
 * A projection rather than a pass-through: `FusedChunk` is an internal shape
 * that may grow fields the API has no business exposing, and an accidental
 * `...spread` onto a response is how internals leak into a contract that
 * clients then depend on.
 */
function toEvidenceChunk(candidate: FusedChunk): EvidenceChunkDto {
  return {
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    documentTitle: candidate.documentTitle,
    text: candidate.text,
    pageNumber: candidate.pageNumber,
    sectionPath: candidate.sectionPath,
    chunkIndex: candidate.chunkIndex,
    tokenCount: candidate.tokenCount,
    score: candidate.score,
    source: candidate.source,
    vectorRank: candidate.vectorRank,
    vectorScore: candidate.vectorScore,
    lexicalRank: candidate.lexicalRank,
    lexicalScore: candidate.lexicalScore,
  };
}
