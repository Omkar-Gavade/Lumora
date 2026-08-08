/**
 * One chunk, as the chunker produces it.
 *
 * `content` is the passage exactly as it appears in the document. It is what a
 * citation shows the user and what `content_tsv` indexes for lexical search.
 *
 * `embedText` is what goes to the embedding provider — the same passage with
 * its section path prepended (docs/05-rag-and-chat.md §2.3: "Prepend the
 * section path to the chunk's **embedded text**"). The two are deliberately
 * separate: storing the enriched form would put "Employment Agreement > 3.
 * Termination" into every citation the user reads and into the lexical index a
 * second time, while embedding the bare form loses the single cheapest
 * accuracy win available.
 */
export interface Chunk {
  index: number;
  content: string;
  embedText: string;
  tokenCount: number;
  /** First page the chunk's text came from; `null` for unpaginated formats. */
  pageNumber: number | null;
  /** `"3. Termination > 3.2 Notice"`, or `null` outside any heading. */
  sectionPath: string | null;
  /** Offsets into the normalized full text — what makes a citation specific. */
  charStart: number;
  charEnd: number;
}

/**
 * Chunking parameters (docs/05-rag-and-chat.md §2.3).
 *
 * The defaults are the documented ones and are not tuning knobs to be guessed
 * at: 512 is small enough that a chunk is *about* one thing and large enough
 * to hold a self-contained answer, and 15% overlap is where recall stops
 * improving meaningfully while storage cost keeps rising.
 */
export interface ChunkOptions {
  /** Target size. Splitting descends only while a piece exceeds `maxTokens`. */
  targetTokens: number;
  /** Hard ceiling. A piece above this is always split further. */
  maxTokens: number;
  /** Below this, a chunk is merged with a neighbour rather than indexed. */
  minTokens: number;
  /** Overlap carried backward from the previous chunk, on sentence bounds. */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 512,
  maxTokens: 800,
  minTokens: 100,
  overlapTokens: 75,
};

/**
 * A block of source text with the structure the parser recovered.
 *
 * The chunker consumes blocks rather than a flat string because the boundaries
 * worth splitting on — heading, paragraph, table, code fence — are structure,
 * and by the time text is one string that information is gone.
 */
export interface SourceBlock {
  kind: 'paragraph' | 'heading' | 'table' | 'code';
  /** The block exactly as it appears in the document, markers and all. */
  text: string;
  /**
   * The heading's own text, without syntax.
   *
   * Separate from `text` because the two differ: a Markdown heading's block
   * text is `"## 3. Termination"` while the section path should read
   * `"3. Termination"`. Prepending the `##` to every embedded chunk would put
   * Markdown syntax into the vector, and into every citation's section label.
   */
  headingText?: string;
  /** Heading depth; only meaningful when `kind` is `'heading'`. */
  level?: number;
  charStart: number;
  charEnd: number;
  pageNumber: number | null;
}
