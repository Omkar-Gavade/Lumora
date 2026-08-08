/**
 * Embedding generation, behind an interface (docs/05-rag-and-chat.md §6).
 *
 * The declaration is the documented one, unchanged:
 *
 * ```ts
 * interface EmbeddingProvider {
 *   readonly name: string;
 *   readonly model: string;
 *   readonly dimensions: number;
 *   embed(texts: string[]): Promise<number[][]>;
 *   embedQuery(text: string): Promise<number[]>;
 * }
 * ```
 *
 * Services depend on this and never import a provider module — the compiler
 * enforces it, because they hold no reference to one.
 */
export interface EmbeddingProvider {
  /** Provider name, for logs and for `usage_events.model` attribution. */
  readonly name: string;
  /** The exact model identifier. Recorded on every document it embeds. */
  readonly model: string;
  /** Vector length. Asserted against the provider's actual output. */
  readonly dimensions: number;

  /**
   * Embeds a batch of **document** texts.
   *
   * Returns one vector per input, in order. Order is part of the contract: the
   * caller pairs results back to chunks positionally, and a provider that
   * reorders or drops silently mislabels every vector in the batch.
   */
  embed(texts: string[]): Promise<number[][]>;

  /**
   * Embeds a **query**.
   *
   * Separate from `embed` because several models are trained asymmetrically
   * with distinct query and document prefixes, and using the document form for
   * queries silently costs recall (§6).
   *
   * Unused in M4b — nothing queries yet. It is declared and implemented now
   * because retrofitting an asymmetric provider after documents are already
   * indexed means re-embedding the corpus.
   */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * A provider-side failure, with the one fact the caller needs.
 *
 * `retryable` is the whole point. A 429 or a 503 is a reason to back off and
 * try again; a 401 or a malformed-request 400 will fail identically on every
 * attempt, and retrying it spends the job's entire budget to reach the same
 * answer three times while the user watches a document sit in `embedding`.
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.cause = cause;
  }
}

/**
 * Classifies an HTTP status into retryable or not.
 *
 * Shared by every provider adapter, because the mapping is a property of HTTP
 * rather than of any one vendor, and three copies of it would drift into three
 * different opinions about 408.
 */
export function isRetryableStatus(status: number): boolean {
  // 408 request timeout, 409 conflict under load, 429 rate limited, and any
  // 5xx. Everything else is a request the caller has to change.
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
