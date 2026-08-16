import {
  ProviderError,
  isRetryableStatus,
} from '../embedding/embedding-provider.interface.js';
import { describeTransport, safeText } from '../embedding/gemini-embedding.provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  LLMProvider,
  StreamChunk,
} from './llm-provider.interface.js';

interface OpenAiChoice {
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string | null;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI chat completions.
 *
 * Over `fetch` rather than the SDK, for the reason docs/05-rag-and-chat.md §6
 * gives for rejecting LangChain and applies equally here: the thing that needs
 * care is mapping HTTP status onto a `retryable` flag the caller can act on,
 * and an SDK hides that behind its own error hierarchy that then has to be
 * re-classified anyway.
 */
export class OpenAiProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    readonly contextWindow: number,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = 120_000,
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await this.post<OpenAiResponse>(this.bodyFor(request, false));
    const choice = response.choices?.[0];

    if (!choice?.message) {
      throw new ProviderError(this.name, 'response contained no completion', true);
    }

    return {
      content: choice.message.content ?? '',
      finishReason: normalizeFinishReason(choice.finish_reason),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const response = await this.send(this.bodyFor(request, true), signal);

    if (!response.body) {
      throw new ProviderError(this.name, 'streaming response had no body', true);
    }

    let finishReason: FinishReason = 'stop';
    let completionTokens = 0;
    let promptTokens = 0;

    for await (const payload of readServerSentEvents(response.body, signal)) {
      // OpenAI terminates its stream with a literal sentinel rather than by
      // closing, so this is the documented end of data.
      if (payload === '[DONE]') break;

      let event: OpenAiResponse;
      try {
        event = JSON.parse(payload) as OpenAiResponse;
      } catch {
        // A malformed frame is skipped rather than fatal: the stream is still
        // producing, and discarding one delta beats discarding the answer.
        continue;
      }

      const choice = event.choices?.[0];
      const text = choice?.delta?.content;

      if (text !== undefined && text.length > 0) {
        completionTokens += 1;
        yield { type: 'token', text };
      }

      if (choice?.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
      if (event.usage) {
        promptTokens = event.usage.prompt_tokens ?? promptTokens;
        completionTokens = event.usage.completion_tokens ?? completionTokens;
      }
    }

    yield {
      type: 'done',
      // An abort is reported as such rather than as a clean stop: the caller
      // persists partial text under a different status for each.
      finishReason: signal.aborted ? 'aborted' : finishReason,
      usage: { promptTokens, completionTokens },
    };
  }

  /**
   * Characters ÷ 4.
   *
   * The real tokenizer is a dependency with megabytes of vocabulary, and this
   * count is used for budgeting — where the consequence of being 10% out is a
   * prompt slightly under or over its allocation, not a failure. The
   * provider's own reported usage is what gets persisted.
   */
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private bodyFor(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: request.temperature ?? 0,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { max_completion_tokens: request.maxOutputTokens }),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.send(body, controller.signal);
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
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
 * Normalizes a vendor's finish reason onto the common vocabulary.
 *
 * The `length` case is the one that matters: it means the answer was truncated
 * mid-thought, and the UI has to say so rather than presenting a cut-off
 * paragraph as a complete reply.
 */
export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
    case 'STOP':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'length';
    case 'content_filter':
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Reads an SSE body and yields each `data:` payload.
 *
 * Written here rather than pulled in as a dependency because the format is six
 * lines of parsing and the one thing that actually matters — that a chunk
 * boundary can fall *inside* a frame — is the thing a hand-rolled
 * `split('\n\n')` per chunk gets wrong. The buffer is what makes a token split
 * across two TCP reads arrive intact instead of as two corrupt frames.
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /*
    A trailing `\r` held back until its partner arrives.

    Without it, a chunk boundary that lands between the `\r` and the `\n` of one
    CRLF would normalize the orphaned `\r` to `\n` and the following `\n` to a
    second one — inventing a frame separator in the middle of an event and
    truncating it. Rare, non-deterministic, and it would look like the model
    occasionally cutting off mid-sentence.
  */
  let pendingCarriageReturn = '';

  /**
   * Emits every `data:` payload in a completed frame.
   *
   * The line-ending normalization above is what makes `startsWith('data:')`
   * and the trailing `.trim()` sufficient — by this point a line cannot end in
   * a stray `\r` that would ride along into the JSON parse.
   */
  function* framesIn(text: string): Generator<string> {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      /*
        CRLF is normalized to LF before anything looks for a separator.

        This is not defensive tidying — it is the difference between a working
        stream and a silent empty one. The SSE grammar admits CR, LF, or CRLF
        as a line terminator, and Gemini's `alt=sse` endpoint uses CRLF, so a
        reader that only knows `\n\n` finds **no** frame boundaries in a
        perfectly valid response: every token stays in the buffer, the stream
        ends, and the caller sees a clean finish with an empty answer and zero
        reported usage. OpenAI happens to send bare LF, which is why this went
        unnoticed until a second provider was exercised end to end.
      */
      const decoded = pendingCarriageReturn + decoder.decode(value, { stream: true });
      pendingCarriageReturn = decoded.endsWith('\r') ? '\r' : '';
      const usable = pendingCarriageReturn === '' ? decoded : decoded.slice(0, -1);

      buffer += usable.replace(/\r\n?/g, '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        yield* framesIn(frame);

        separator = buffer.indexOf('\n\n');
      }
    }

    /*
      Whatever is left when the stream ends.

      A server is not obliged to terminate its final event with a blank line
      before closing the connection, and discarding the tail loses the last
      chunk of the answer — which is where `finishReason` and usage live.
    */
    if (!signal.aborted) {
      const tail = (buffer + pendingCarriageReturn).replace(/\r\n?/g, '\n');
      if (tail.length > 0) yield* framesIn(tail);
    }
  } finally {
    // Releases the underlying connection. Without it an aborted stream leaks a
    // socket per cancelled generation.
    await reader.cancel().catch(() => undefined);
  }
}
