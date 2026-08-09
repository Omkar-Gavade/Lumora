/** FR: the states a message can be in. Mirrors the `message_status` enum. */
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'stopped' | 'failed';

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * One citation, as the UI renders it.
 *
 * `contentSnapshot` is the passage text frozen at answer time
 * (docs/04-data-and-api.md §1.1) — which is why a citation still resolves
 * after the document behind it has been deleted.
 */
export interface CitationDto {
  /** The `[n]` shown in the answer. 1-based. */
  citationIndex: number;
  chunkId: string;
  documentId: string;
  /** `null` once the document is gone; the snapshot survives regardless. */
  documentTitle: string | null;
  pageNumber: number | null;
  sectionPath: string | null;
  score: number;
  contentSnapshot: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  sequence: number;
  /** Regeneration lineage — the message this one replaced. */
  parentId: string | null;
  model: string | null;
  /**
   * Present only on a `failed` message, and a machine code rather than a
   * sentence: the frontend owns the wording, so a copy change is not a
   * backend deploy.
   */
  errorCode: string | null;
  finishReason: string | null;
  citations: CitationDto[];
  createdAt: string;
}

export interface ConversationDto {
  id: string;
  title: string;
  /** `false` while the thread still carries its placeholder name. */
  titleGenerated: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Cursor paginated, like every list in the API (docs §2). */
export interface ConversationListDto {
  items: ConversationDto[];
  nextCursor: string | null;
}

/** A thread with its messages — what the chat page renders on load. */
export interface ConversationDetailDto {
  conversation: ConversationDto;
  messages: MessageDto[];
}

/**
 * The result of one non-streaming turn.
 *
 * Carries both messages because the client needs the user turn's server-assigned
 * id and sequence, not just the reply — an optimistic bubble has to be
 * reconciled with the row that was actually written.
 */
export interface TurnDto {
  userMessage: MessageDto;
  assistantMessage: MessageDto;
  /** Every source that reached the prompt, numbered as the answer cites them. */
  sources: TurnSourceDto[];
  /** `true` when retrieval found nothing and the model was never called. */
  abstained: boolean;
}

/**
 * A source as it appeared in the prompt.
 *
 * Distinct from `CitationDto`: this is everything the model *could* have used,
 * while a citation is what it actually used. The sources panel shows the
 * former so a user can see what was considered and rejected.
 */
export interface TurnSourceDto {
  /** The `[n]` this source was given in the prompt. */
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  text: string;
  pageNumber: number | null;
  sectionPath: string | null;
  score: number;
}
