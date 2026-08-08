import {
  ProviderError,
  isRetryableStatus,
  type EmbeddingProvider,
} from './embedding-provider.interface.js';

interface GeminiEmbedResponse {
  embeddings?: { values?: number[] }[];
}

interface GeminiSingleEmbedResponse {
  embedding?: { values?: number[] };
}

/**
 * Google Gemini embeddings.
 *
 * Called over `fetch` rather than through `@google/generative-ai`. The SDK
 * would add a dependency to shape two JSON bodies, and the thing that actually
 * needs care here — mapping HTTP status onto a `retryable` flag the job queue
 * can act on — is something an SDK hides behind its own error hierarchy that
 * then has to be re-classified anyway.
 *
 * **`taskType` is the reason `embedQuery` exists as a separate method.** Gemini
 * is trained asymmetrically: `RETRIEVAL_DOCUMENT` and `RETRIEVAL_QUERY`
 * produce different vectors for the same text, and embedding a query with the
 * document task silently costs recall (docs/05-rag-and-chat.md §6).
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';

  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private readonly timeoutMs = 30_000,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: this.dimensions,
      })),
    };

    const response = await this.post<GeminiEmbedResponse>(
      `models/${this.model}:batchEmbedContents`,
      body,
    );

    const vectors = response.embeddings?.map((entry) => entry.values ?? []) ?? [];

    /*
      Length is checked, not assumed. The caller pairs vectors back to chunks
      positionally, so a short response would attach every vector to the wrong
      chunk from that index on — a corruption that produces plausible-looking
      data and surfaces only as bad retrieval months later.
    */
    if (vectors.length !== texts.length) {
      throw new ProviderError(
        this.name,
        `expected ${String(texts.length)} embeddings, received ${String(vectors.length)}`,
        // Retryable: a truncated response is more likely a transport fault
        // than a permanent contract change.
        true,
      );
    }

    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const response = await this.post<GeminiSingleEmbedResponse>(
      `models/${this.model}:embedContent`,
      {
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: this.dimensions,
      },
    );

    const values = response.embedding?.values;
    if (!values) throw new ProviderError(this.name, 'response contained no embedding', true);

    return values;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    // An explicit timeout, because `fetch` has none by default: a provider
    // that accepts the connection and never answers would otherwise hold the
    // job until the lease expires and the reaper takes it back.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header, not a query parameter: a key in a URL is logged by every
          // proxy between here and Google.
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // Network faults and timeouts are transient by nature.
      throw new ProviderError(this.name, describeTransport(error), true, undefined, error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = await safeText(response);
      throw new ProviderError(
        this.name,
        `HTTP ${String(response.status)}: ${detail}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

/** Reads an error body without letting a failed read mask the real failure. */
export async function safeText(response: Response): Promise<string> {
  try {
    // Truncated: a provider error page can be a full HTML document, and only
    // the first line is ever diagnostic.
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable response body>';
  }
}

export function describeTransport(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'request timed out';
  return error instanceof Error ? error.message : String(error);
}
