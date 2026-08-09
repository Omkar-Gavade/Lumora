import { ProviderError } from '../embedding/embedding-provider.interface.js';

/** One turn in the prompt, in the shape every chat API accepts. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: PromptMessage[];
  /**
   * 0 by default, not the provider's own default.
   *
   * This is a grounded question-answering system: the same sources and the
   * same question should produce the same answer, and creativity is a defect
   * here rather than a feature. A provider default of 0.7 would make two
   * identical questions disagree about what a contract says.
   */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Why generation stopped.
 *
 * Normalized across providers because the caller acts on it: `length` means the
 * answer was cut off and the UI must say so, while `stop` means the model
 * finished. Leaving each vendor's spelling (`max_tokens`, `MAX_TOKENS`,
 * `length`) to the call site is how that distinction gets lost.
 */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'aborted' | 'error';

export interface CompletionResponse {
  content: string;
  finishReason: FinishReason;
  usage: CompletionUsage;
}

/** One piece of a streamed response. */
export type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'done'; finishReason: FinishReason; usage: CompletionUsage };

/**
 * Text generation, behind an interface (docs/05-rag-and-chat.md §6).
 *
 * The declaration is the documented one:
 *
 * ```ts
 * interface LLMProvider {
 *   readonly name: string;
 *   readonly model: string;
 *   readonly contextWindow: number;
 *   complete(req: CompletionRequest): Promise<CompletionResponse>;
 *   stream(req: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
 *   countTokens(text: string): number;
 * }
 * ```
 *
 * "Services depend on the interface and never import a provider module — the
 * compiler enforces this because they have no reference to one."
 *
 * Adapters own request shaping, streaming normalization into a common
 * `StreamChunk`, error mapping to `ProviderError` with a `retryable` flag,
 * token accounting, and rate-limit handling with backoff.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Total tokens the model accepts, prompt plus output.
   *
   * On the interface rather than in config because it is a property of the
   * model, not a preference — and because the prompt builder needs it to
   * refuse a prompt that cannot fit before paying to discover that.
   */
  readonly contextWindow: number;

  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Streams a response, abortable.
   *
   * Declared and implemented in M6a; **nothing calls it yet.** The SSE
   * orchestrator is M6b. It is here because §6 specifies it and because an
   * interface whose second half arrives later gets shaped around whatever the
   * first consumer happened to need.
   *
   * The `AbortSignal` is a parameter rather than an option so it cannot be
   * forgotten: a user who navigates away must stop incurring generation cost
   * immediately (docs/03-backend.md §8).
   */
  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;

  /**
   * An approximate token count for budgeting.
   *
   * Synchronous, so the prompt builder can enforce docs §4.1's allocations
   * "by counting before assembly rather than hoping" without an await in the
   * middle of assembling a string.
   */
  countTokens(text: string): number;
}

export { ProviderError };
