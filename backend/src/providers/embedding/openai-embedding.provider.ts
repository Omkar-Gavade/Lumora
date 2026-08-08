import {
  ProviderError,
  isRetryableStatus,
  type EmbeddingProvider,
} from './embedding-provider.interface.js';
import { describeTransport, safeText } from './gemini-embedding.provider.js';

interface OpenAiEmbedResponse {
  data?: { index?: number; embedding?: number[] }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * OpenAI embeddings.
 *
 * Symmetric, unlike Gemini: `text-embedding-3-*` uses one representation for
 * documents and queries, so `embedQuery` delegates to `embed`. That is a
 * property of the model, not a shortcut — the interface keeps the two methods
 * separate precisely so a provider can answer this question for itself
 * (docs/05-rag-and-chat.md §6).
 *
 * `dimensions` is sent explicitly. The v3 models support Matryoshka
 * truncation, so the same model can return 256, 512, 1536, or 3072 dimensions;
 * leaving it to the default means a config change to `EMBEDDING_DIMENSIONS`
 * silently disagrees with what is actually stored.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    readonly dimensions: number,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = 30_000,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await this.post<OpenAiEmbedResponse>('embeddings', {
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
      encoding_format: 'float',
    });

    const data = response.data ?? [];

    if (data.length !== texts.length) {
      throw new ProviderError(
        this.name,
        `expected ${String(texts.length)} embeddings, received ${String(data.length)}`,
        true,
      );
    }

    /*
      Sorted by `index` rather than trusted in arrival order.

      OpenAI documents that `data` may be returned out of order. The caller
      pairs vectors to chunks positionally, so honouring the declared index is
      the difference between correct vectors and every chunk in the batch
      labelled with a neighbour's embedding.
    */
    const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));

    return ordered.map((entry, position) => {
      const embedding = entry.embedding;
      if (!embedding) {
        throw new ProviderError(
          this.name,
          `embedding missing at index ${String(position)}`,
          true,
        );
      }
      return embedding;
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    if (!vector) throw new ProviderError(this.name, 'response contained no embedding', true);
    return vector;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
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
