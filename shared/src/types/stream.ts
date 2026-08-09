import type { CitationDto, MessageDto, TurnSourceDto } from './chat.js';

/**
 * The named SSE events, exactly as docs/03-backend.md §8 lists them.
 *
 * ```
 * event: status     data: {"phase":"retrieving"}
 * event: sources    data: {"sources":[…]}
 * event: token      data: {"text":"Revenue "}
 * event: citation   data: {"index":1,"chunkId":"…"}
 * event: done       data: {"messageId":"…","usage":{…},"finishReason":"stop"}
 * event: error      data: {"code":"PROVIDER_ERROR","message":"…"}
 * ```
 *
 * A discriminated union rather than a bag of optional fields: the client
 * switches on `event`, and a payload that could be any shape would make every
 * handler defensive about fields that cannot be present.
 */

/**
 * What the server is doing right now.
 *
 * docs/00-product.md §8.3: "These are real phases reported by the server over
 * the stream, not fake theatre — showing a spinner labeled with something that
 * is not happening is a trust leak."
 */
export type StreamPhase = 'retrieving' | 'generating';

export interface StreamStatusEvent {
  event: 'status';
  data: { phase: StreamPhase; /** Passages found, once retrieval finishes. */ sourceCount?: number };
}

export interface StreamSourcesEvent {
  event: 'sources';
  data: { sources: TurnSourceDto[] };
}

export interface StreamTokenEvent {
  event: 'token';
  data: { text: string };
}

export interface StreamCitationEvent {
  event: 'citation';
  data: CitationDto;
}

/** Emitted when titling lands, which is after the answer (§7 step 13). */
export interface StreamTitleEvent {
  event: 'title';
  data: { conversationId: string; title: string };
}

export interface StreamDoneEvent {
  event: 'done';
  data: {
    messageId: string;
    usage: { promptTokens: number; completionTokens: number };
    /** `stop` | `length` | `aborted` | `abstained` — why generation ended. */
    finishReason: string;
    /** The finalized message, so the client replaces its optimistic copy. */
    message: MessageDto;
  };
}

export interface StreamErrorEvent {
  event: 'error';
  data: { code: string; message: string };
}

export type ChatStreamEvent =
  | StreamStatusEvent
  | StreamSourcesEvent
  | StreamTokenEvent
  | StreamCitationEvent
  | StreamTitleEvent
  | StreamDoneEvent
  | StreamErrorEvent;
