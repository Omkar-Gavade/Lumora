import type {
  CompletionRequest,
  CompletionResponse,
  FinishReason,
  LLMProvider,
  StreamChunk,
} from './llm-provider.interface.js';

/**
 * A deterministic LLM for tests and offline development.
 *
 * **Deterministic, and grounded in the prompt it was given.** The default
 * answer cites the sources it can actually see, because the properties this
 * fake has to support are citation mapping, validation, and budgeting — and
 * every one of those is untestable against a provider that returns a fixed
 * string with no `[n]` in it.
 *
 * It is not pretending to be intelligent. It reads the source block, emits a
 * sentence per source with the matching marker, and stops. That is enough to
 * exercise the whole orchestration path for free, which is what keeps the path
 * exercised.
 */
export class FakeLLMProvider implements LLMProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly contextWindow: number;

  /** Every request, for assertions about what the prompt builder produced. */
  readonly calls: CompletionRequest[] = [];

  /** Queued responses, shifted one per call. Overrides the default behaviour. */
  private readonly scripted: (string | Error)[] = [];
  private nextFinishReason: FinishReason | null = null;
  /** Milliseconds between streamed tokens, for abort tests. */
  private streamDelayMs = 0;

  constructor(options: { model?: string; contextWindow?: number } = {}) {
    this.model = options.model ?? 'fake-llm-001';
    this.contextWindow = options.contextWindow ?? 32_000;
  }

  /** Makes the next call return `text`, or throw if given an `Error`. */
  scriptNext(text: string | Error): void {
    this.scripted.push(text);
  }

  /** Forces the finish reason of the next response — used for `length` tests. */
  finishNextWith(reason: FinishReason): void {
    this.nextFinishReason = reason;
  }

  /** Slows streaming so a test can abort mid-response. */
  setStreamDelay(ms: number): void {
    this.streamDelayMs = ms;
  }

  reset(): void {
    this.calls.length = 0;
    this.scripted.length = 0;
    this.nextFinishReason = null;
    this.streamDelayMs = 0;
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);

    const scripted = this.scripted.shift();
    if (scripted instanceof Error) return Promise.reject(scripted);

    const content = scripted ?? this.groundedAnswer(request);
    const finishReason = this.takeFinishReason();

    return Promise.resolve({
      content,
      finishReason,
      usage: {
        promptTokens: this.countTokens(request.messages.map((m) => m.content).join('\n')),
        completionTokens: this.countTokens(content),
      },
    });
  }

  async *stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.calls.push(request);

    const scripted = this.scripted.shift();
    if (scripted instanceof Error) throw scripted;

    const content = scripted ?? this.groundedAnswer(request);

    /*
      Split on whitespace boundaries with the space retained, so reassembling
      every token yields the original string exactly. A naive `split(' ')`
      loses the separators and makes the accumulated text differ from what
      `complete` would have returned for the same prompt — which would let a
      streaming bug hide behind a passing non-streaming test.
    */
    const tokens = content.match(/\S+\s*/g) ?? [];
    let emitted = 0;

    for (const text of tokens) {
      if (signal.aborted) {
        yield {
          type: 'done',
          finishReason: 'aborted',
          usage: { promptTokens: 0, completionTokens: emitted },
        };
        return;
      }

      if (this.streamDelayMs > 0) await delay(this.streamDelayMs, signal);

      emitted += 1;
      yield { type: 'token', text };
    }

    yield {
      type: 'done',
      finishReason: this.takeFinishReason(),
      usage: {
        promptTokens: this.countTokens(request.messages.map((m) => m.content).join('\n')),
        completionTokens: this.countTokens(content),
      },
    };
  }

  /**
   * The same four-characters-per-token estimate the rest of the codebase uses.
   *
   * Deliberately the estimate and not a real tokenizer: a fake whose counts
   * disagreed with the budgeting code would make budget tests assert the
   * fake's arithmetic rather than the builder's.
   */
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private takeFinishReason(): FinishReason {
    const reason = this.nextFinishReason ?? 'stop';
    this.nextFinishReason = null;
    return reason;
  }

  /**
   * Answers from the source block, citing each source it used.
   *
   * Reads the `[n]` markers out of the assembled context so the answer's
   * citations are genuinely derived from the prompt. That is what makes
   * citation validation testable: change the prompt, and the citations change
   * with it.
   */
  private groundedAnswer(request: CompletionRequest): string {
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';

    /*
      Titling is a different job and needs a different answer.

      A titling prompt carries no sources, so without this branch the fake
      returns its abstention text — and the conversation gets named "The
      provided sources do not contain". That is not a bug in titling; it is a
      test double that stops standing in for the thing it doubles, which makes
      every titling assertion vacuous.
    */
    if (system.includes('Write a title')) {
      const question = request.messages.find((message) => message.role === 'user')?.content ?? '';
      return titleFrom(question);
    }

    const indices = [...system.matchAll(/^\[(\d+)]/gm)].map((match) => Number(match[1]));

    if (indices.length === 0) {
      // No sources in the prompt. The abstention path normally prevents this,
      // so answering anyway would let a missing-source bug look like a working
      // model.
      return 'The provided sources do not contain an answer to that question.';
    }

    return indices
      .map((index) => `This is a grounded statement drawn from source ${String(index)} [${String(index)}].`)
      .join(' ');
  }
}

/**
 * A plausible six-word title from a question.
 *
 * Deterministic, like everything else here: the same question always produces
 * the same title, so a test can assert the value rather than only its shape.
 */
function titleFrom(question: string): string {
  const words = question
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 4);

  if (words.length === 0) return 'New conversation';

  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/** A sleep that rejects nothing and simply returns early when aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
