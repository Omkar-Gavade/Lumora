import {
  ProviderError,
  isRetryableStatus,
} from '../embedding/embedding-provider.interface.js';
import { describeTransport, safeText } from '../embedding/gemini-embedding.provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  PromptMessage,
  StreamChunk,
} from './llm-provider.interface.js';
import { normalizeFinishReason, readServerSentEvents } from './openai.provider.js';

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Google Gemini text generation.
 *
 * The shape differs from OpenAI's in two ways this adapter has to absorb, and
 * absorbing them here is exactly what the `LLMProvider` interface is for:
 *
 * **There is no `system` role.** Gemini takes a separate `systemInstruction`
 * field, so the system message is lifted out of `messages` rather than sent as
 * a turn. Sending it as a `user` turn — the obvious workaround — degrades
 * instruction following measurably, and the grounding rules in §4.3 are
 * precisely the instructions that must not be degraded.
 *
 * **The assistant role is called `model`.** A conversation replayed with the
 * wrong role name reads to the API as the user having said everything, which
 * makes multi-turn history useless.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  constructor(
    readonly model: string,
    readonly contextWindow: number,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    private readonly timeoutMs = 120_000,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.post<GeminiResponse>(
      `models/${this.model}:generateContent`,
      this.bodyFor(request),
    );

    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new ProviderError(this.name, 'response contained no candidate', true);
    }

    return {
      content: textOf(candidate),
      finishReason: normalizeFinishReason(candidate.finishReason),
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    // `alt=sse` is what makes Gemini emit Server-Sent Events rather than a
    // JSON array streamed in fragments, which cannot be parsed incrementally.
    const response = await this.send(
      `models/${this.model}:streamGenerateContent?alt=sse`,
      this.bodyFor(request),
      signal,
    );

    if (!response.body) {
      throw new ProviderError(this.name, 'streaming response had no body', true);
    }

    let finishReason = 'stop';
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const payload of readServerSentEvents(response.body, signal)) {
      let event: GeminiResponse;
      try {
        event = JSON.parse(payload) as GeminiResponse;
      } catch {
        continue;
      }

      const candidate = event.candidates?.[0];
      const text = candidate === undefined ? '' : textOf(candidate);

      if (text.length > 0) yield { type: 'token', text };
      if (candidate?.finishReason) finishReason = candidate.finishReason;

      if (event.usageMetadata) {
        promptTokens = event.usageMetadata.promptTokenCount ?? promptTokens;
        completionTokens = event.usageMetadata.candidatesTokenCount ?? completionTokens;
      }
    }

    yield {
      type: 'done',
      finishReason: signal.aborted ? 'aborted' : normalizeFinishReason(finishReason),
      usage: { promptTokens, completionTokens },
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private bodyFor(request: CompletionRequest): Record<string, unknown> {
    const system = request.messages.filter((message) => message.role === 'system');
    const turns = request.messages.filter((message) => message.role !== 'system');

    return {
      contents: turns.map((message) => ({
        role: geminiRole(message),
        parts: [{ text: message.content }],
      })),
      ...(system.length === 0
        ? {}
        : {
            systemInstruction: {
              parts: system.map((message) => ({ text: message.content })),
            },
          }),
      generationConfig: {
        temperature: request.temperature ?? 0,
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
      },
    };
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.send(path, body, controller.signal);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
    /*
      Retry, because Gemini's transient failures are frequent enough to be a
      product problem rather than an edge case.

      Observed repeatedly during development: 503 on a healthy request, and 429
      when a per-minute quota briefly fills. Both are transient and both
      currently surface to the user as a failed turn, because the embedding
      path retries per batch and the chat path does not retry at all.

      Only `retryable` errors are retried, so a 400 (a malformed prompt) or a
      401 (a bad key) fails immediately — retrying those wastes the user's time
      to reach the same answer. An abort is never retried: the user asked to
      stop.
    */
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (signal.aborted) break;

      try {
        return await this.attempt(path, body, signal);
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable) throw error;

        lastError = error;
        if (attempt === MAX_RETRIES) break;

        /*
          Exponential with jitter. The jitter matters more than the base here:
          several concurrent turns failing on the same quota window would
          otherwise retry in lockstep and refill it together.
        */
        const backoff = BASE_BACKOFF_MS * 2 ** attempt;
        const delay = backoff + Math.floor(Math.random() * backoff);

        await sleep(delay, signal);
      }
    }

    throw lastError ?? new ProviderError(this.name, 'request aborted', false);
  }

  /** One attempt, with no retry logic of its own. */
  private async attempt(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Response> {
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
        signal,
      });
    } catch (error) {
      throw new ProviderError(this.name, describeTransport(error), true, undefined, error);
    }

    if (!response.ok) {
      throw new ProviderError(
        this.name,
        `HTTP ${String(response.status)}: ${await safeText(response)}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    return response;
  }
}

/**
 * Three retries, so four attempts in total.
 *
 * Enough to ride out a quota window boundary or a single unlucky 503, and few
 * enough that a genuine outage fails in about seven seconds rather than
 * holding an SSE connection open while the user waits.
 */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

/** A delay that gives up immediately when the turn is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new ProviderError('gemini', 'request aborted', false));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `assistant` → `model`; everything else is a user turn. */
function geminiRole(message: PromptMessage): string {
  return message.role === 'assistant' ? 'model' : 'user';
}

/** Joins a candidate's parts. Gemini splits one reply across several. */
function textOf(candidate: GeminiCandidate): string {
  return (candidate.content?.parts ?? []).map((part) => part.text ?? '').join('');
}
