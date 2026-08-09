import { normalizeUnicode } from '../documents/parsing/normalize.js';

/**
 * Prepares a user's query for retrieval **without changing what it means**.
 *
 * That constraint is the whole design. docs/05-rag-and-chat.md §3.1 reserves
 * meaning-changing transformation for the LLM rewrite step — which runs only
 * with conversation history, is used only for retrieval, and is deliberately
 * not part of this milestone. Everything here is the other kind of work:
 * making the *same* question match text that was itself normalized at
 * ingestion.
 *
 * The pairing matters. Chunk text went through `normalizeUnicode` before it
 * was embedded and before `content_tsv` was generated, so a query containing a
 * typographic apostrophe searches a corpus that contains ASCII ones. Skipping
 * this step is a silent recall loss on exactly the queries users type from a
 * word processor.
 */
export interface NormalizedQuery {
  /** What the retrievers see. */
  text: string;
  /** What the user typed, preserved for display and for the eventual prompt. */
  original: string;
}

export function normalizeQuery(raw: string): NormalizedQuery {
  const original = raw.trim();

  const text = collapseWhitespace(stripTrailingPunctuation(normalizeUnicode(original)));

  return { text, original };
}

/**
 * Collapses every run of whitespace to one space.
 *
 * Unlike the document normalizer, paragraph breaks are **not** preserved: a
 * query has no paragraphs, and a pasted multi-line question should embed as
 * one sentence rather than as text with structure the chunker would have cared
 * about.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Removes trailing punctuation that carries no retrieval signal.
 *
 * "What is the notice period?" and "What is the notice period" should not be
 * two different queries. The trailing `?`/`!`/`.` contributes nothing to a
 * dense vector and is a stop character to the lexical parser, so dropping it
 * only removes noise.
 *
 * **Only trailing, and only these three.** Internal punctuation is left
 * completely alone, because stripping it is exactly how a query for a product
 * code — `ACME-1200/B`, `v2.1.3`, `§3.2` — stops matching the identifiers that
 * §3.2 names as the lexical half's whole reason for existing. Question marks
 * inside a query are also left, since they can be part of a quoted string.
 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[?!.\s]+$/, '');
}
